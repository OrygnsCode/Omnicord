import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIGuildMember,
  APIMessage,
  APIRole,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import {
  getRoles,
  getBotUser,
  getChannels,
  invalidateGuildCaches,
  CHANNEL_TYPE_LABELS,
} from "../discord/guildData.js";
import {
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
  digestMessage,
  ToolProblem,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
  parseHexColor,
  embedsParam,
  mapEmbeds,
} from "./common.js";

// Management tools: the update and delete half of CRUD for channels and
// roles, plus message editing and pinning. The deletes run through the
// confirmation gate; the updates honor dry_run.

const P = PermissionFlagsBits;

// Shared role resolution with the safety checks every role mutation needs:
// the role must exist, must not be integration-managed, must not be
// @everyone, and must sit below the bot's highest role.
async function resolveManageableRole(
  rest: Awaited<ReturnType<typeof enter>>["rest"],
  guildId: string,
  roleQuery: string
): Promise<{ role: APIRole; warnings: string[] }> {
  const roles = await getRoles(rest, guildId);
  const resolution = resolveOne(
    roleQuery,
    roles
      .filter((r) => r.id !== guildId)
      .map((r) => ({ id: r.id, name: r.name, type: "role" }))
  );
  if (!("match" in resolution)) {
    throw new ToolProblem(
      fail(`No single role matches "${roleQuery}".`, {
        candidates: "candidates" in resolution ? resolution.candidates : [],
      })
    );
  }
  const role = roles.find((r) => r.id === resolution.match.id);
  if (!role) {
    throw new ToolProblem(fail(`Role "${roleQuery}" disappeared mid-call.`));
  }
  if (role.managed) {
    throw new ToolProblem(
      fail(
        `${role.name} is managed by an integration and cannot be changed ` +
          "manually."
      )
    );
  }

  const botUser = await getBotUser(rest);
  const botMember = (await rest.get(
    Routes.guildMember(guildId, botUser.id)
  )) as APIGuildMember;
  const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
  requirePermissions(botPerms, [[P.ManageRoles, "Manage Roles"]], "in this server");

  const warnings: string[] = [];
  const botTop = highestRolePosition(botMember.roles, roles);
  if (role.position > botTop) {
    throw new ToolProblem(
      fail(
        `The bot's highest role (position ${botTop}) is below ${role.name} ` +
          `(position ${role.position}). Discord will reject this. Move the ` +
          "bot's role above the target role."
      )
    );
  }
  if (role.position === botTop) {
    warnings.push(
      "The target role shares the bot's highest position; Discord may " +
        "reject the change."
    );
  }
  return { role, warnings };
}

export function registerManageTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "update_channel",
    {
      title: "Update channel",
      description:
        "Edit a channel's name, topic, slowmode, NSFW flag, or category. " +
        "Only passed fields change. Pass category \"none\" to move a " +
        "channel out of its category. Supports dry_run.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100).optional(),
        topic: z.string().max(1024).optional(),
        slowmode_seconds: z.number().int().min(0).max(21600).optional(),
        nsfw: z.boolean().optional(),
        category: z.string().optional()
          .describe("Category name or ID, or \"none\" to remove."),
        dry_run: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      channel,
      guild,
      name,
      topic,
      slowmode_seconds,
      nsfw,
      category,
      dry_run,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);

      if (
        name === undefined &&
        topic === undefined &&
        slowmode_seconds === undefined &&
        nsfw === undefined &&
        category === undefined
      ) {
        return fail("Pass at least one field to change.");
      }
      if (topic !== undefined && (target.type === 2 || target.type === 13)) {
        return fail("Voice and stage channels have no topic.");
      }

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.ManageChannels, "Manage Channels"]],
        `for #${target.name}`
      );

      let parentId: string | null | undefined;
      if (category !== undefined) {
        if (category.toLowerCase() === "none") {
          parentId = null;
        } else {
          const parent = await resolveChannel(rest, guildId, category, [4]);
          parentId = parent.id;
        }
      }

      const changes: string[] = [];
      if (name !== undefined) changes.push(`name to "${name}"`);
      if (topic !== undefined) changes.push("topic");
      if (slowmode_seconds !== undefined)
        changes.push(`slowmode to ${slowmode_seconds}s`);
      if (nsfw !== undefined) changes.push(`nsfw to ${nsfw}`);
      if (parentId !== undefined)
        changes.push(parentId === null ? "out of its category" : "category");

      if (dry_run) {
        return ok(
          `Dry run: would change ${changes.join(", ")} on #${target.name}. ` +
            "Nothing was changed.",
          { executed: false }
        );
      }

      await rest.patch(Routes.channel(target.id), {
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(topic !== undefined ? { topic } : {}),
          ...(slowmode_seconds !== undefined
            ? { rate_limit_per_user: slowmode_seconds }
            : {}),
          ...(nsfw !== undefined ? { nsfw } : {}),
          ...(parentId !== undefined ? { parent_id: parentId } : {}),
        },
        reason: "Updated via Omnicord",
      });
      invalidateGuildCaches(guildId);

      return ok(`Updated #${target.name}: ${changes.join(", ")}.`, {
        id: target.id,
        changed: changes,
      });
    })
  );

  server.registerTool(
    "delete_channel",
    {
      title: "Delete channel",
      description:
        "Delete a channel or category. Safe to call directly: the first " +
        "call deletes nothing and returns a preview plus a confirm_token, " +
        "and the deletion only happens when the call is repeated with that " +
        "token. When the user asks to delete something, call this and " +
        "relay the preview for their go-ahead instead of sending them to " +
        "do it manually in Discord; the gate exists exactly so deletion " +
        "can be approved through the conversation. Deleting a category " +
        "leaves its channels in place, uncategorized.",
      inputSchema: {
        channel: z.string().describe("Channel or category name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ channel, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);
      const kind = CHANNEL_TYPE_LABELS[target.type] ?? `type ${target.type}`;

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.ManageChannels, "Manage Channels"]],
        `for ${target.name}`
      );

      let childNote = "";
      if (target.type === 4) {
        const children = (await getChannels(rest, guildId)).filter(
          (c) => c.parent_id === target.id
        );
        childNote =
          children.length > 0
            ? ` Its ${children.length} channel(s) survive and become uncategorized.`
            : "";
      }

      const gate = gateDestructive({
        tool: "delete_channel",
        args: { channel: target.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the ${kind} ${target.name} (${target.id}).` +
          (target.type === 4
            ? childNote
            : " Every message in it is lost forever.") ,
        previewDetails: { id: target.id, name: target.name, type: kind },
      });
      if (gate) return gate;

      await rest.delete(Routes.channel(target.id), {
        reason: reason ?? "Deleted via Omnicord",
      });
      invalidateGuildCaches(guildId);

      return ok(`Deleted the ${kind} ${target.name}.`, {
        deleted: true,
        id: target.id,
      });
    })
  );

  server.registerTool(
    "update_role",
    {
      title: "Update role",
      description:
        "Edit a role's name, color, hoist, mentionable flag, or " +
        "permissions. Passing preset and/or permissions replaces the " +
        "role's permission set with the named bundle plus listed names. " +
        "Only passed fields change. Supports dry_run.",
      inputSchema: {
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100).optional(),
        color: z.string().optional().describe("Hex color like #00b0f4."),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
        preset: z.enum(["none", "member", "moderator", "admin"]).optional(),
        permissions: z.array(z.string()).optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      role,
      guild,
      name,
      color,
      hoist,
      mentionable,
      preset,
      permissions,
      dry_run,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const { role: target, warnings } = await resolveManageableRole(
        rest,
        guildId,
        role
      );

      const changingPerms = preset !== undefined || permissions !== undefined;
      if (
        name === undefined &&
        color === undefined &&
        hoist === undefined &&
        mentionable === undefined &&
        !changingPerms
      ) {
        return fail("Pass at least one field to change.");
      }

      let bits: bigint | undefined;
      if (changingPerms) {
        bits = PERMISSION_PRESETS[preset ?? "none"];
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
        if (botPerms !== ALL_PERMISSIONS) {
          const beyond = bits & ~botPerms;
          if (beyond !== 0n) {
            return fail(
              "The new permission set includes permissions the bot itself " +
                `lacks: ${describePermissions(beyond).join(", ")}. Discord ` +
                "rejects that."
            );
          }
        }
      }

      const changes: string[] = [];
      if (name !== undefined) changes.push(`name to "${name}"`);
      if (color !== undefined) changes.push(`color to ${color}`);
      if (hoist !== undefined) changes.push(`hoist to ${hoist}`);
      if (mentionable !== undefined) changes.push(`mentionable to ${mentionable}`);
      if (bits !== undefined)
        changes.push(`permissions (${describePermissions(bits).length} granted)`);

      if (dry_run) {
        return ok(
          `Dry run: would change ${changes.join(", ")} on ${target.name}. ` +
            "Nothing was changed.",
          { executed: false },
          warnings
        );
      }

      await rest.patch(Routes.guildRole(guildId, target.id), {
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(color !== undefined ? { color: parseHexColor(color) } : {}),
          ...(hoist !== undefined ? { hoist } : {}),
          ...(mentionable !== undefined ? { mentionable } : {}),
          ...(bits !== undefined ? { permissions: bits.toString() } : {}),
        },
        reason: "Updated via Omnicord",
      });
      invalidateGuildCaches(guildId);

      return ok(
        `Updated role ${target.name}: ${changes.join(", ")}.`,
        { id: target.id, changed: changes },
        warnings
      );
    })
  );

  server.registerTool(
    "delete_role",
    {
      title: "Delete role",
      description:
        "Delete a role. Members holding it simply lose it; nothing else " +
        "changes. Safe to call directly: the first call deletes nothing " +
        "and returns a preview plus a confirm_token, and the deletion only " +
        "happens when the call is repeated with that token. Prefer this " +
        "gated flow over telling the user to delete the role manually.",
      inputSchema: {
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ role, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const { role: target } = await resolveManageableRole(
        rest,
        guildId,
        role
      );

      const gate = gateDestructive({
        tool: "delete_role",
        args: { role: target.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the role ${target.name} (position ` +
          `${target.position}). Members holding it lose it; channel ` +
          "overrides referencing it are removed.",
        previewDetails: { id: target.id, name: target.name },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildRole(guildId, target.id), {
        reason: reason ?? "Deleted via Omnicord",
      });
      invalidateGuildCaches(guildId);

      return ok(`Deleted the role ${target.name}.`, {
        deleted: true,
        id: target.id,
      });
    })
  );

  server.registerTool(
    "edit_message",
    {
      title: "Edit message",
      description:
        "Edit a message the bot itself sent. Discord does not allow " +
        "editing anyone else's messages, no matter the permission level.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
        content: z.string().min(1).max(2000).optional(),
        embeds: embedsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, content, embeds }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );
      if (content === undefined && embeds === undefined) {
        return fail("Pass content or embeds to change.");
      }

      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      const botUser = await getBotUser(rest);
      if (message.author.id !== botUser.id) {
        return fail(
          "That message was sent by " +
            `${message.author.global_name ?? message.author.username}, not ` +
            "the bot. Discord only allows editing your own messages."
        );
      }

      await rest.patch(Routes.channelMessage(target.id, message_id), {
        body: {
          ...(content !== undefined ? { content } : {}),
          ...(embeds !== undefined ? { embeds: mapEmbeds(embeds) } : {}),
        },
      });

      return ok(`Edited the bot's message in #${target.name}.`, {
        id: message_id,
        channel: { id: target.id, name: target.name },
      });
    })
  );

  server.registerTool(
    "pin_message",
    {
      title: "Pin message",
      description:
        "Pin a message in a channel. Needs the Pin Messages permission " +
        "(split from Manage Messages in 2026). Channels hold at most 50 pins.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );
      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.PinMessages, "Pin Messages"]],
        `in #${target.name}`
      );

      await rest.put(Routes.channelMessagesPin(target.id, message_id), {
        reason: reason ?? "Pinned via Omnicord",
      });
      return ok(`Pinned message ${message_id} in #${target.name}.`, {
        pinned: true,
        id: message_id,
      });
    })
  );

  server.registerTool(
    "unpin_message",
    {
      title: "Unpin message",
      description: "Unpin a message. The message itself is untouched.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );
      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.PinMessages, "Pin Messages"]],
        `in #${target.name}`
      );

      await rest.delete(Routes.channelMessagesPin(target.id, message_id), {
        reason: reason ?? "Unpinned via Omnicord",
      });
      return ok(`Unpinned message ${message_id} in #${target.name}.`, {
        pinned: false,
        id: message_id,
      });
    })
  );

  server.registerTool(
    "list_pinned_messages",
    {
      title: "List pinned messages",
      description: "Pinned messages in a channel, newest pin first.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );

      const result = (await rest.get(
        Routes.channelMessagesPins(target.id)
      )) as { items: Array<{ pinned_at: string; message: APIMessage }> };

      const pins = (result.items ?? []).map((item) => ({
        pinned_at: item.pinned_at,
        ...digestMessage(item.message),
      }));

      return ok(`${pins.length} pinned message(s) in #${target.name}.`, {
        channel: { id: target.id, name: target.name },
        pins,
      });
    })
  );
}
