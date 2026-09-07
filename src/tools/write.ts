import { z } from "zod";
import { Routes, PermissionFlagsBits, MessageReferenceType } from "discord-api-types/v10";
import type {
  APIGuildMember,
  APIMessage,
  APIRole,
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIGuildChannelJSONBody,
  RESTPostAPIGuildRoleJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import {
  getChannels,
  getRoles,
  getBotUser,
  invalidateGuildCaches,
  type GuildChannelLite,
} from "../discord/guildData.js";
import {
  compileComponents,
  componentsParam,
  COMPONENTS_V2_FLAG,
  type ComponentBlock,
} from "../discord/components.js";
import {
  compileOverwrites,
  EveryoneRoleError,
  UnknownRoleError,
  type OverwriteSpec,
} from "../builder/overwrites.js";
import {
  computeChannelPermissions,
  computeGuildPermissions,
  highestRolePosition,
  parsePermissionNames,
  describePermissions,
  listPermissionNames,
  PERMISSION_PRESETS,
  ALL_PERMISSIONS,
} from "../discord/preflight.js";
import { resolveOne } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  resolveMember,
  memberDisplayName,
  ToolProblem,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
  parseHexColor,
  embedsParam,
  mapEmbeds,
} from "./common.js";

// Write tools: the Phase 2 core. Everything here changes state on Discord,
// so every tool preflights the bot's actual permissions and explains what
// is missing instead of letting Discord answer with a bare 403. The one
// destructive tool here, delete_message, runs through the confirmation
// gate in safety.ts.

const P = PermissionFlagsBits;

function jumpLink(guildId: string, channelId: string, messageId: string) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// allowed_mentions presets. The default is none: a model echoing user text
// must never be able to mass-ping by accident.
const MENTION_MODES: Record<string, string[]> = {
  none: [],
  users: ["users"],
  roles_and_users: ["users", "roles"],
  everything: ["users", "roles", "everyone"],
};

export function registerWriteTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Send a message to a channel, optionally as a reply, with embeds, " +
        "or as a Components V2 layout of text, sections, image galleries, " +
        "separators and link buttons inside colored containers. Components " +
        "replace content and embeds rather than joining them, and the " +
        "choice is permanent for that message. For a private message to " +
        "one person use send_dm; to post under a custom name and avatar " +
        "use send_webhook_message; to send later use schedule_message. " +
        "Mentions are suppressed by default; raise the mentions mode only " +
        "deliberately. Supports dry_run.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        content: z.string().min(1).max(2000).optional()
          .describe("Message text. Required unless components is used."),
        reply_to: z.string().optional()
          .describe("Message ID to reply to."),
        mentions: z
          .enum(["none", "users", "roles_and_users", "everything"])
          .optional()
          .describe("Which mention types may ping. Default none."),
        silent: z.boolean().optional()
          .describe("Send without triggering notifications."),
        embeds: embedsParam,
        components: componentsParam,
        dry_run: z.boolean().optional()
          .describe("Preview without sending."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      channel,
      guild,
      content,
      reply_to,
      mentions,
      silent,
      embeds,
      components,
      dry_run,
    }) => {
      // Components V2 is a whole-message mode, not an extra field. Discord
      // stops rendering content and embeds on a message once its flag is
      // set, and the flag can never be cleared, so a call that asks for
      // both is refused instead of silently losing the text.
      const layout = components as ComponentBlock[] | undefined;
      if (layout && content !== undefined) {
        return fail(
          "content and components cannot be combined. Setting the " +
            "Components V2 flag stops Discord from rendering content on " +
            "that message, permanently. Put the text in a text block " +
            "instead."
        );
      }
      if (layout && embeds && embeds.length > 0) {
        return fail(
          "embeds and components cannot be combined. Embeds stop rendering " +
            "on a Components V2 message. A container with an accent_color " +
            "is the closest equivalent."
        );
      }
      if (!layout && content === undefined) {
        return fail("Pass content, or components for a rich layout.");
      }

      let compiled: ReturnType<typeof compileComponents> | undefined;
      if (layout) {
        compiled = compileComponents(layout);
        if (!compiled.ok) return fail(compiled.reason);
      }

      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );

      const perms = await botPermissions(rest, guildId, target);
      const needed: Array<[bigint, string]> = [
        [P.ViewChannel, "View Channel"],
        [P.SendMessages, "Send Messages"],
      ];
      // Galleries and thumbnails render as embedded media, so they need the
      // same permission an embed does.
      if ((embeds && embeds.length > 0) || (compiled?.ok && compiled.hasMedia)) {
        needed.push([P.EmbedLinks, "Embed Links"]);
      }
      if (mentions === "everything") {
        needed.push([P.MentionEveryone, "Mention Everyone"]);
      }
      requirePermissions(perms, needed, `in #${target.name}`);

      if (dry_run) {
        return ok(
          "Dry run: would send " +
            (compiled?.ok
              ? `a ${compiled.count}-component layout`
              : `${content?.length ?? 0} characters`) +
            ` to #${target.name}` +
            (reply_to ? ` as a reply to ${reply_to}` : "") +
            (embeds?.length ? ` with ${embeds.length} embed(s)` : "") +
            ". Nothing was sent.",
          { executed: false, channel: { id: target.id, name: target.name } }
        );
      }

      const mode = mentions ?? "none";
      // Both flags live in the same field, so silent has to be OR'd in
      // rather than assigned.
      let flags = 0;
      if (silent) flags |= 4096;
      if (compiled?.ok) flags |= COMPONENTS_V2_FLAG;

      const body: RESTPostAPIChannelMessageJSONBody = {
        ...(content !== undefined ? { content } : {}),
        allowed_mentions: {
          parse: MENTION_MODES[mode] as never,
          replied_user: mode !== "none",
        },
        ...(reply_to ? { message_reference: { message_id: reply_to } } : {}),
        ...(flags !== 0 ? { flags } : {}),
        ...(embeds && embeds.length > 0 ? { embeds: mapEmbeds(embeds) } : {}),
        ...(compiled?.ok ? { components: compiled.components as never } : {}),
      };

      const sent = (await rest.post(Routes.channelMessages(target.id), {
        body,
      })) as APIMessage;

      return ok(
        `Sent to #${target.name}` +
          (reply_to ? ` as a reply` : "") +
          `. Message ID ${sent.id}.`,
        {
          id: sent.id,
          channel: { id: target.id, name: target.name },
          jump_link: jumpLink(guildId, target.id, sent.id),
          ...(compiled?.ok ? { components_v2: true } : {}),
        },
        compiled?.ok
          ? [
              "This message is now a Components V2 message. It can be " +
                "edited with components, but never with content or embeds.",
            ]
          : undefined
      );
    })
  );

  server.registerTool(
    "forward_message",
    {
      title: "Forward message",
      description:
        "Forward a message from one channel into another, the way the " +
        "Discord client's forward does: the original travels along as a " +
        "quoted snapshot. Works across channels in the server. An optional " +
        "note is posted as its own message just before the forward, since " +
        "Discord does not allow text on the forward itself.",
      inputSchema: {
        guild: guildParam,
        channel: z.string().describe("Channel to forward the message into (name or ID)."),
        from_channel: z.string().describe("Channel the message is currently in (name or ID)."),
        message_id: z.string().describe("ID of the message to forward."),
        content: z.string().max(2000).optional()
          .describe("Optional note, posted as a separate message just before the forward."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, channel, from_channel, message_id, content }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
      const source = await resolveChannel(rest, guildId, from_channel, TEXT_BEARING_TYPES);

      const targetPerms = await botPermissions(rest, guildId, target);
      requirePermissions(
        targetPerms,
        [[P.ViewChannel, "View Channel"], [P.SendMessages, "Send Messages"]],
        `in #${target.name}`
      );
      const sourcePerms = await botPermissions(rest, guildId, source);
      requirePermissions(
        sourcePerms,
        [[P.ViewChannel, "View Channel"], [P.ReadMessageHistory, "Read Message History"]],
        `in #${source.name}`
      );

      // Discord rejects content on the forward itself, so a note goes as its
      // own message just before the forwarded snapshot.
      let note: APIMessage | undefined;
      if (content) {
        note = (await rest.post(Routes.channelMessages(target.id), {
          body: {
            content,
            allowed_mentions: { parse: [] as never },
          } as RESTPostAPIChannelMessageJSONBody,
        })) as APIMessage;
      }

      const sent = (await rest.post(Routes.channelMessages(target.id), {
        body: {
          allowed_mentions: { parse: [] as never },
          message_reference: {
            type: MessageReferenceType.Forward,
            channel_id: source.id,
            message_id,
          },
        } as RESTPostAPIChannelMessageJSONBody,
      })) as APIMessage;

      return ok(
        `Forwarded the message into #${target.name}. Message ID ${sent.id}.` +
          (note ? " Posted your note with it." : ""),
        {
          id: sent.id,
          channel: { id: target.id, name: target.name },
          from: { id: source.id, name: source.name },
          note_id: note?.id ?? null,
          jump_link: jumpLink(guildId, target.id, sent.id),
        }
      );
    })
  );

  server.registerTool(
    "create_channel",
    {
      title: "Create channel",
      description:
        "Create a text, voice, forum, stage, announcement, or category " +
        "channel, optionally inside a category, and optionally private or " +
        "read-only from the start. private_to, read_only and posting_roles " +
        "compile to permission overwrites and are applied in the same call, " +
        "so a private channel is one request rather than a create followed " +
        "by set_channel_permissions. Use set_channel_permissions for " +
        "anything finer. Supports dry_run.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(1).max(100).describe("Channel name."),
        type: z
          .enum(["text", "voice", "forum", "stage", "announcement", "category"])
          .optional()
          .describe("Channel type. Default text."),
        category: z.string().optional()
          .describe("Category name or ID to place the channel under."),
        topic: z.string().max(1024).optional()
          .describe("Channel topic, for text-like channels."),
        slowmode_seconds: z.number().int().min(0).max(21600).optional()
          .describe("Per-user message cooldown."),
        nsfw: z.boolean().optional(),
        private_to: z.array(z.string()).max(20).optional()
          .describe(
            "Role names that can see the channel. Everyone else is denied " +
              "View Channel, and Connect too on voice, stage and category. " +
              "Do not list @everyone."
          ),
        read_only: z.boolean().optional()
          .describe(
            "Deny sending to everyone, for rules and announcement channels."
          ),
        posting_roles: z.array(z.string()).max(20).optional()
          .describe(
            "Role names that may still post when read_only is set. Has no " +
              "effect on its own."
          ),
        dry_run: z.boolean().optional()
          .describe("Preview without creating."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      guild,
      name,
      type,
      category,
      topic,
      slowmode_seconds,
      nsfw,
      private_to,
      read_only,
      posting_roles,
      dry_run,
    }) => {
      const { rest, guildId } = await enter(config, guild);

      const typeMap: Record<string, number> = {
        text: 0,
        voice: 2,
        category: 4,
        announcement: 5,
        stage: 13,
        forum: 15,
      };
      const kind = type ?? "text";
      const typeCode = typeMap[kind];

      if (category && kind === "category") {
        return fail("A category cannot be placed inside another category.");
      }

      // posting_roles is an exception carved out of read_only. On its own
      // there is nothing to except: everyone can already post.
      if ((posting_roles?.length ?? 0) > 0 && read_only !== true) {
        return fail(
          "posting_roles only means something alongside read_only, which " +
            "is what denies posting in the first place. Set read_only true " +
            "or drop posting_roles."
        );
      }

      const restricted = (private_to?.length ?? 0) > 0 || read_only === true;

      const perms = await botPermissions(rest, guildId);
      const needed: Array<[bigint, string]> = [
        [P.ManageChannels, "Manage Channels"],
      ];
      // Overwrites are role permissions, and Discord gates writing them
      // separately from creating the channel.
      if (restricted) needed.push([P.ManageRoles, "Manage Roles"]);
      requirePermissions(perms, needed, "in this server");

      let parent: GuildChannelLite | undefined;
      if (category) {
        parent = await resolveChannel(rest, guildId, category, [4]);
      }

      let overwrites: OverwriteSpec[] = [];
      if (restricted) {
        const roles = await getRoles(rest, guildId);
        // Discord lets two roles share a name. Picking either one would be
        // a guess about who can see the channel, so an ambiguous reference
        // is refused rather than resolved.
        const byName = new Map<string, string>();
        const ambiguous = new Set<string>();
        for (const r of roles) {
          if (!r.name) continue;
          const key = r.name.toLowerCase();
          if (byName.has(key)) ambiguous.add(key);
          else byName.set(key, r.id);
        }
        const clashes = [
          ...new Set(
            [...(private_to ?? []), ...(posting_roles ?? [])].filter((n) =>
              ambiguous.has(n.toLowerCase())
            )
          ),
        ];
        if (clashes.length > 0) {
          return fail(
            `This server has more than one role named ` +
              `${clashes.map((c) => `"${c}"`).join(" and ")}, so it is not ` +
              "clear which should get access. Rename one, or create the " +
              "channel plainly and use set_channel_permissions, which takes " +
              "a role ID."
          );
        }

        const botUser = await getBotUser(rest);
        try {
          overwrites = compileOverwrites(
            {
              kind,
              privateTo: private_to,
              readOnly: read_only,
              postingRoles: posting_roles,
            },
            byName,
            guildId,
            botUser.id
          );
        } catch (err) {
          if (err instanceof UnknownRoleError) {
            return fail(err.message, {
              available_roles: roles
                .filter((r) => r.id !== guildId)
                .map((r) => r.name),
            });
          }
          if (err instanceof EveryoneRoleError) return fail(err.message);
          throw err;
        }
      }

      // Said the same way in the dry run and in the result, so a preview
      // and the real thing never describe the outcome differently.
      const access = restricted
        ? (private_to?.length
            ? `, visible only to ${private_to.join(", ")}`
            : "") +
          (read_only
            ? `, read-only${
                posting_roles?.length
                  ? ` except for ${posting_roles.join(", ")}`
                  : ""
              }`
            : "")
        : "";

      if (dry_run) {
        return ok(
          `Dry run: would create ${kind} channel "${name}"` +
            (parent ? ` under category ${parent.name}` : "") +
            access +
            ". Nothing was created.",
          {
            executed: false,
            ...(restricted ? { permission_overwrites: overwrites } : {}),
          }
        );
      }

      const body: RESTPostAPIGuildChannelJSONBody = {
        name,
        type: typeCode as never,
        ...(parent ? { parent_id: parent.id } : {}),
        ...(topic ? { topic } : {}),
        ...(slowmode_seconds !== undefined
          ? { rate_limit_per_user: slowmode_seconds }
          : {}),
        ...(nsfw !== undefined ? { nsfw } : {}),
        ...(overwrites.length > 0
          ? { permission_overwrites: overwrites as never }
          : {}),
      };

      const created = (await rest.post(Routes.guildChannels(guildId), {
        body,
        reason: "Created via Omnicord",
      })) as GuildChannelLite;
      invalidateGuildCaches(guildId);

      return ok(
        `Created ${kind} channel ${created.name} (${created.id})` +
          (parent ? ` under ${parent.name}` : "") +
          access +
          (kind === "text" && created.name !== name
            ? `. Discord normalized the name from "${name}".`
            : "."),
        {
          id: created.id,
          name: created.name,
          type: kind,
          category: parent ? { id: parent.id, name: parent.name } : null,
          ...(restricted ? { permission_overwrites: overwrites } : {}),
        }
      );
    })
  );

  server.registerTool(
    "create_role",
    {
      title: "Create role",
      description:
        "Create a role from a vetted preset (none, member, moderator, " +
        "admin) and/or an explicit list of permission names. Administrator " +
        "is never granted by a preset; it must be spelled out explicitly. " +
        "Supports dry_run.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(1).max(100).describe("Role name."),
        preset: z
          .enum(["none", "member", "moderator", "admin"])
          .optional()
          .describe("Vetted permission bundle. Default none."),
        permissions: z
          .array(z.string())
          .optional()
          .describe(
            "Extra permission names, like manage_messages or ban_members."
          ),
        color: z.string().optional().describe("Hex color like #00b0f4."),
        hoist: z.boolean().optional()
          .describe("Show members separately in the sidebar."),
        mentionable: z.boolean().optional(),
        dry_run: z.boolean().optional()
          .describe("Preview without creating."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      guild,
      name,
      preset,
      permissions,
      color,
      hoist,
      mentionable,
      dry_run,
    }) => {
      const { rest, guildId } = await enter(config, guild);

      let bits = PERMISSION_PRESETS[preset ?? "none"];
      if (permissions && permissions.length > 0) {
        const parsed = parsePermissionNames(permissions);
        if (parsed.unknown.length > 0) {
          return fail(
            `Unknown permission name(s): ${parsed.unknown.join(", ")}.`,
            { valid_names: listPermissionNames() }
          );
        }
        bits |= parsed.bits;
      }

      const botPerms = await botPermissions(rest, guildId);
      requirePermissions(
        botPerms,
        [[P.ManageRoles, "Manage Roles"]],
        "in this server"
      );
      // Discord rejects granting permissions the bot itself lacks, unless
      // the bot is an administrator. Catch it here with a useful message.
      if (botPerms !== ALL_PERMISSIONS) {
        const beyond = bits & ~botPerms;
        if (beyond !== 0n) {
          return fail(
            "The requested role would grant permissions the bot itself " +
              `lacks: ${describePermissions(beyond).join(", ")}. Discord ` +
              "rejects that. Drop those permissions or raise the bot's role."
          );
        }
      }

      const grantSummary = describePermissions(bits);
      if (dry_run) {
        return ok(
          `Dry run: would create role "${name}" with ` +
            `${grantSummary.length} permission(s). Nothing was created.`,
          { executed: false, permissions: grantSummary }
        );
      }

      const body: RESTPostAPIGuildRoleJSONBody = {
        name,
        permissions: bits.toString(),
        ...(color ? { color: parseHexColor(color) } : {}),
        ...(hoist !== undefined ? { hoist } : {}),
        ...(mentionable !== undefined ? { mentionable } : {}),
      };

      const created = (await rest.post(Routes.guildRoles(guildId), {
        body,
        reason: "Created via Omnicord",
      })) as APIRole;
      invalidateGuildCaches(guildId);

      return ok(
        `Created role ${created.name} (${created.id}) with ` +
          `${grantSummary.length} permission(s).`,
        {
          id: created.id,
          name: created.name,
          position: created.position,
          permissions: grantSummary,
        }
      );
    })
  );

  server.registerTool(
    "assign_role",
    {
      title: "Assign role",
      description:
        "Give a member a role. Preflights the bot's role hierarchy so the " +
        "failure mode is an explanation, not a 403. Supports dry_run.",
      inputSchema: {
        guild: guildParam,
        member: z.string().describe("Member name or user ID."),
        role: z.string().describe("Role name or ID."),
        reason: z.string().max(400).optional()
          .describe("Audit log reason."),
        dry_run: z.boolean().optional()
          .describe("Preview without assigning."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, member, role, reason, dry_run }) => {
      const { rest, guildId } = await enter(config, guild);

      const [target, roles, botUser] = await Promise.all([
        resolveMember(rest, guildId, member),
        getRoles(rest, guildId),
        getBotUser(rest),
      ]);

      const resolution = resolveOne(
        role,
        roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }
      const targetRole = roles.find((r) => r.id === resolution.match.id);
      if (!targetRole) return fail(`Role "${role}" disappeared mid-call.`);

      if (targetRole.managed) {
        return fail(
          `${targetRole.name} is managed by an integration and cannot be ` +
            "assigned manually."
        );
      }

      if (!target.user) return fail(`Could not load member "${member}".`);
      if (target.roles.includes(targetRole.id)) {
        return ok(
          `${memberDisplayName(target)} already has the role ` +
            `${targetRole.name}. Nothing to do.`,
          { already_assigned: true }
        );
      }

      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;
      const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
      requirePermissions(
        botPerms,
        [[P.ManageRoles, "Manage Roles"]],
        "in this server"
      );

      // Hierarchy: a bot can only manage roles strictly below its own
      // highest role, unless it is an administrator... and even then
      // Discord enforces hierarchy for role assignment. Equal positions
      // are ambiguous; warn and let Discord arbitrate.
      const warnings: string[] = [];
      const botTop = highestRolePosition(botMember.roles, roles);
      if (targetRole.position > botTop) {
        return fail(
          `The bot's highest role (position ${botTop}) is below ` +
            `${targetRole.name} (position ${targetRole.position}). Discord ` +
            "will reject this. Move the bot's role above the target role."
        );
      }
      if (targetRole.position === botTop) {
        warnings.push(
          "The target role shares the bot's highest position; Discord may " +
            "reject the assignment."
        );
      }

      if (dry_run) {
        return ok(
          `Dry run: would give ${targetRole.name} to ` +
            `${memberDisplayName(target)}. Nothing was changed.`,
          { executed: false },
          warnings
        );
      }

      await rest.put(
        Routes.guildMemberRole(guildId, target.user.id, targetRole.id),
        { reason: reason ?? "Assigned via Omnicord" }
      );

      return ok(
        `Gave ${targetRole.name} to ${memberDisplayName(target)}.`,
        {
          member: { id: target.user.id, name: memberDisplayName(target) },
          role: { id: targetRole.id, name: targetRole.name },
        },
        warnings
      );
    })
  );

  server.registerTool(
    "delete_message",
    {
      title: "Delete message",
      description:
        "Delete one message. Safe to call directly: the first call deletes " +
        "nothing and returns a preview plus a confirm_token, and the " +
        "deletion only happens when the call is repeated with that token. " +
        "Use this two-step flow to let the user approve through the " +
        "conversation rather than telling them to delete things by hand " +
        "in Discord. Supports dry_run.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string().describe("ID of the message to delete."),
        reason: z.string().max(400).optional()
          .describe("Audit log reason."),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional()
          .describe("Token from a previous preview of this exact deletion."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({
      channel,
      guild,
      message_id,
      reason,
      dry_run,
      confirm_token,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );

      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;

      const botUser = await getBotUser(rest);
      if (message.author.id !== botUser.id) {
        const perms = await botPermissions(rest, guildId, target);
        requirePermissions(
          perms,
          [[P.ManageMessages, "Manage Messages"]],
          `in #${target.name}`
        );
      }

      const excerpt = (message.content ?? "").slice(0, 120);
      const gate = gateDestructive({
        tool: "delete_message",
        args: { channel: target.id, message_id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete a message by ` +
          `${message.author.global_name ?? message.author.username} in ` +
          `#${target.name}: "${excerpt}". Deletion cannot be undone.`,
        previewDetails: {
          message_id,
          author: message.author.username,
          excerpt,
          created_at: message.timestamp,
          attachments: (message.attachments ?? []).length,
        },
      });
      if (gate) return gate;

      await rest.delete(Routes.channelMessage(target.id, message_id), {
        reason: reason ?? "Deleted via Omnicord",
      });

      return ok(
        `Deleted the message by ` +
          `${message.author.global_name ?? message.author.username} in ` +
          `#${target.name}.`,
        { deleted: true, message_id }
      );
    })
  );
}
