import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIEmoji,
  APIExtendedInvite,
  APIInvite,
  APIMessage,
  APIWebhook,
  RESTPostAPIChannelInviteJSONBody,
  RESTPostAPIWebhookWithTokenJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getChannels } from "../discord/guildData.js";
import { resolveOne } from "../discord/resolve.js";
import {
  fetchImageAsDataUri,
  MAX_EMOJI_BYTES,
  MAX_AVATAR_BYTES,
} from "../discord/images.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  ToolProblem,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
  embedsParam,
  mapEmbeds,
} from "./common.js";

// Invites, webhooks, and custom emojis.

const P = PermissionFlagsBits;

function inviteDigest(invite: APIExtendedInvite) {
  return {
    code: invite.code,
    url: `https://discord.gg/${invite.code}`,
    channel: invite.channel
      ? { id: invite.channel.id, name: invite.channel.name }
      : null,
    inviter: invite.inviter?.username ?? null,
    uses: invite.uses ?? 0,
    max_uses: invite.max_uses ?? 0,
    expires_at: invite.expires_at ?? null,
  };
}

// Webhook tokens grant posting rights to anyone holding them, so they
// never leave this module. Everything returned to the model is the
// token-free view.
function webhookDigest(hook: APIWebhook) {
  return {
    id: hook.id,
    name: hook.name,
    channel_id: hook.channel_id,
    application_owned: Boolean(hook.application_id),
  };
}

async function listGuildWebhooks(rest: REST, guildId: string): Promise<APIWebhook[]> {
  return (await rest.get(Routes.guildWebhooks(guildId))) as APIWebhook[];
}

async function resolveWebhook(
  rest: REST,
  guildId: string,
  query: string
): Promise<APIWebhook> {
  const hooks = await listGuildWebhooks(rest, guildId);
  const resolution = resolveOne(
    query,
    hooks.map((h) => ({ id: h.id, name: h.name ?? "", type: "webhook" }))
  );
  if ("match" in resolution) {
    const hook = hooks.find((h) => h.id === resolution.match.id);
    if (hook) return hook;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No webhook matching "${query}" in this server.`)
      : fail(`Multiple webhooks match "${query}". Pick one by ID.`, { candidates })
  );
}

export function registerCommunityTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "create_invite",
    {
      title: "Create invite",
      description:
        "Create an invite link for a channel. Defaults are deliberate: " +
        "expires in 24 hours, unlimited uses. A never-expiring invite must " +
        "be asked for explicitly with max_age_seconds 0.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        max_age_seconds: z.number().int().min(0).max(604800).optional()
          .describe("Lifetime in seconds, 0 for never. Default 86400 (24h)."),
        max_uses: z.number().int().min(0).max(100).optional()
          .describe("Use limit, 0 for unlimited. Default 0."),
        temporary: z.boolean().optional()
          .describe("Members who join leave again when they disconnect."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, max_age_seconds, max_uses, temporary }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.CreateInstantInvite, "Create Invite"]],
        `in ${target.name}`
      );

      const body: RESTPostAPIChannelInviteJSONBody = {
        max_age: max_age_seconds ?? 86400,
        max_uses: max_uses ?? 0,
        temporary: temporary ?? false,
        unique: true,
      };
      const invite = (await rest.post(Routes.channelInvites(target.id), {
        body,
        reason: "Created via Omnicord",
      })) as APIExtendedInvite;

      return ok(
        `Invite https://discord.gg/${invite.code} for ${target.name}, ` +
          ((max_age_seconds ?? 86400) === 0
            ? "never expires"
            : `expires in ${Math.round((max_age_seconds ?? 86400) / 3600)} hour(s)`) +
          `, ${max_uses ? `${max_uses} use(s)` : "unlimited uses"}.`,
        inviteDigest(invite)
      );
    })
  );

  server.registerTool(
    "list_invites",
    {
      title: "List invites",
      description: "Active invites for the server or one channel.",
      inputSchema: {
        guild: guildParam,
        channel: z.string().optional()
          .describe("Limit to one channel."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      let invites: APIExtendedInvite[];
      if (channel) {
        const target = await resolveChannel(rest, guildId, channel);
        invites = (await rest.get(Routes.channelInvites(target.id))) as APIExtendedInvite[];
      } else {
        invites = (await rest.get(Routes.guildInvites(guildId))) as APIExtendedInvite[];
      }

      return ok(`${invites.length} active invite(s).`, {
        invites: invites.map(inviteDigest),
      });
    })
  );

  server.registerTool(
    "get_invite",
    {
      title: "Get invite",
      description: "Inspect an invite code: where it leads and how used it is.",
      inputSchema: {
        code: z.string().describe("The invite code, with or without discord.gg/."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ code }) => {
      const { rest } = await enter(config, undefined);
      const clean = code.replace(/^(https?:\/\/)?(discord\.gg\/|discord\.com\/invite\/)/, "");
      const invite = (await rest.get(Routes.invite(clean), {
        query: new URLSearchParams({ with_counts: "true" }),
      })) as APIInvite;

      return ok(
        `Invite ${clean} leads to ${invite.guild?.name ?? "an unknown server"}` +
          (invite.channel?.name ? `, channel ${invite.channel.name}` : "") +
          `. About ${invite.approximate_member_count ?? "?"} members.`,
        {
          code: clean,
          guild: invite.guild ? { id: invite.guild.id, name: invite.guild.name } : null,
          channel: invite.channel
            ? { id: invite.channel.id, name: invite.channel.name }
            : null,
          members_approximate: invite.approximate_member_count ?? null,
          online_approximate: invite.approximate_presence_count ?? null,
          expires_at: invite.expires_at ?? null,
        }
      );
    })
  );

  server.registerTool(
    "delete_invite",
    {
      title: "Delete invite",
      description:
        "Revoke an invite link. Safe to call directly: the first call " +
        "changes nothing and returns a preview plus a confirm_token; " +
        "repeating the call with the token revokes it.",
      inputSchema: {
        code: z.string().describe("The invite code to revoke."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ code, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const clean = code.replace(/^(https?:\/\/)?(discord\.gg\/|discord\.com\/invite\/)/, "");

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageChannels, "Manage Channels"]],
        "in this server"
      );

      const gate = gateDestructive({
        tool: "delete_invite",
        args: { code: clean },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would revoke the invite ${clean}. Anyone holding the link can ` +
          "no longer use it.",
        previewDetails: { code: clean },
      });
      if (gate) return gate;

      await rest.delete(Routes.invite(clean), {
        reason: reason ?? "Revoked via Omnicord",
      });
      return ok(`Revoked the invite ${clean}.`, { revoked: true, code: clean });
    })
  );

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhooks",
      description:
        "Webhooks in the server or one channel. Tokens are never included.",
      inputSchema: {
        guild: guildParam,
        channel: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], "in this server");

      let hooks: APIWebhook[];
      if (channel) {
        const target = await resolveChannel(rest, guildId, channel);
        hooks = (await rest.get(Routes.channelWebhooks(target.id))) as APIWebhook[];
      } else {
        hooks = await listGuildWebhooks(rest, guildId);
      }

      const channels = await getChannels(rest, guildId);
      const names = new Map(channels.map((c) => [c.id, c.name]));
      return ok(`${hooks.length} webhook(s).`, {
        webhooks: hooks.map((h) => ({
          ...webhookDigest(h),
          channel_name: names.get(h.channel_id ?? "") ?? null,
        })),
      });
    })
  );

  server.registerTool(
    "create_webhook",
    {
      title: "Create webhook",
      description:
        "Create an incoming webhook on a channel. Webhooks post with any " +
        "display name and avatar, which is how messages 'as someone' work " +
        "legitimately.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(80),
        avatar_url: z.string().url().optional()
          .describe("Image for the webhook's default avatar, up to 1 MB."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, name, avatar_url }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], `in #${target.name}`);

      let avatar: string | undefined;
      if (avatar_url) {
        const image = await fetchImageAsDataUri(avatar_url, MAX_AVATAR_BYTES);
        if (!image.ok) return fail(image.error);
        avatar = image.dataUri;
      }

      const hook = (await rest.post(Routes.channelWebhooks(target.id), {
        body: { name, ...(avatar ? { avatar } : {}) },
        reason: "Created via Omnicord",
      })) as APIWebhook;

      return ok(`Created webhook ${hook.name} on #${target.name}.`, webhookDigest(hook));
    })
  );

  server.registerTool(
    "update_webhook",
    {
      title: "Update webhook",
      description: "Rename a webhook, change its avatar, or move it to another channel.",
      inputSchema: {
        webhook: z.string().describe("Webhook name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(80).optional(),
        channel: z.string().optional()
          .describe("Move the webhook to this channel."),
        avatar_url: z.string().url().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ webhook, guild, name, channel, avatar_url }) => {
      const { rest, guildId } = await enter(config, guild);
      const hook = await resolveWebhook(rest, guildId, webhook);
      if (name === undefined && channel === undefined && avatar_url === undefined) {
        return fail("Pass at least one field to change.");
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], "in this server");

      let channelId: string | undefined;
      if (channel) {
        const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
        channelId = target.id;
      }
      let avatar: string | undefined;
      if (avatar_url) {
        const image = await fetchImageAsDataUri(avatar_url, MAX_AVATAR_BYTES);
        if (!image.ok) return fail(image.error);
        avatar = image.dataUri;
      }

      const updated = (await rest.patch(Routes.webhook(hook.id), {
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(channelId !== undefined ? { channel_id: channelId } : {}),
          ...(avatar !== undefined ? { avatar } : {}),
        },
        reason: "Updated via Omnicord",
      })) as APIWebhook;

      return ok(`Updated webhook ${updated.name}.`, webhookDigest(updated));
    })
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete webhook",
      description:
        "Delete a webhook. Anything still posting through it stops " +
        "working. Safe to call directly: the first call changes nothing " +
        "and returns a preview plus a confirm_token; repeating the call " +
        "with the token deletes it.",
      inputSchema: {
        webhook: z.string().describe("Webhook name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ webhook, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const hook = await resolveWebhook(rest, guildId, webhook);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], "in this server");

      const gate = gateDestructive({
        tool: "delete_webhook",
        args: { webhook: hook.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the webhook ${hook.name} (${hook.id}). Integrations ` +
          "posting through it break immediately.",
        previewDetails: webhookDigest(hook),
      });
      if (gate) return gate;

      await rest.delete(Routes.webhook(hook.id), {
        reason: reason ?? "Deleted via Omnicord",
      });
      return ok(`Deleted the webhook ${hook.name}.`, { deleted: true, id: hook.id });
    })
  );

  server.registerTool(
    "send_webhook_message",
    {
      title: "Send webhook message",
      description:
        "Post through a webhook with an optional display name and avatar " +
        "override. Mentions are suppressed.",
      inputSchema: {
        webhook: z.string().describe("Webhook name or ID."),
        guild: guildParam,
        content: z.string().min(1).max(2000).optional(),
        embeds: embedsParam,
        username_override: z.string().min(1).max(80).optional(),
        avatar_url_override: z.string().url().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      webhook,
      guild,
      content,
      embeds,
      username_override,
      avatar_url_override,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      if (!content && (!embeds || embeds.length === 0)) {
        return fail("Pass content or embeds.");
      }
      const hook = await resolveWebhook(rest, guildId, webhook);
      if (!hook.token) {
        return fail(
          `The webhook ${hook.name} is owned by another application, so ` +
            "its posting token is not available to this bot."
        );
      }

      const body: RESTPostAPIWebhookWithTokenJSONBody = {
        ...(content ? { content } : {}),
        ...(embeds && embeds.length > 0 ? { embeds: mapEmbeds(embeds) } : {}),
        ...(username_override ? { username: username_override } : {}),
        ...(avatar_url_override ? { avatar_url: avatar_url_override } : {}),
        allowed_mentions: { parse: [] },
      };
      const sent = (await rest.post(Routes.webhook(hook.id, hook.token), {
        body,
        query: new URLSearchParams({ wait: "true" }),
        auth: false,
      })) as APIMessage;

      return ok(
        `Posted through ${hook.name}` +
          (username_override ? ` as "${username_override}"` : "") +
          `.`,
        {
          id: sent.id,
          channel_id: sent.channel_id,
          jump_link: `https://discord.com/channels/${guildId}/${sent.channel_id}/${sent.id}`,
        }
      );
    })
  );

  server.registerTool(
    "list_emojis",
    {
      title: "List emojis",
      description: "Custom emojis in the server, with usage syntax.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const emojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
      return ok(`${emojis.length} custom emoji(s).`, {
        emojis: emojis.map((e) => ({
          id: e.id,
          name: e.name,
          animated: e.animated ?? false,
          usage: e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`,
        })),
      });
    })
  );

  server.registerTool(
    "create_emoji",
    {
      title: "Create emoji",
      description:
        "Upload a custom emoji from an image URL. Discord's limit for " +
        "emoji files is 256 KB; png, jpeg, gif, and webp work.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(32).regex(/^[A-Za-z0-9_]+$/,
          "Letters, digits, and underscores only."),
        image_url: z.string().url(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, image_url }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const image = await fetchImageAsDataUri(image_url, MAX_EMOJI_BYTES);
      if (!image.ok) return fail(image.error);

      const emoji = (await rest.post(Routes.guildEmojis(guildId), {
        body: { name, image: image.dataUri },
        reason: "Created via Omnicord",
      })) as APIEmoji;

      return ok(
        `Created the emoji :${emoji.name}: . Use it as <:${emoji.name}:${emoji.id}>.`,
        { id: emoji.id, name: emoji.name }
      );
    })
  );

  server.registerTool(
    "update_emoji",
    {
      title: "Update emoji",
      description: "Rename a custom emoji.",
      inputSchema: {
        emoji: z.string().describe("Current emoji name or ID."),
        guild: guildParam,
        name: z.string().min(2).max(32).regex(/^[A-Za-z0-9_]+$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ emoji, guild, name }) => {
      const { rest, guildId } = await enter(config, guild);
      const emojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
      const resolution = resolveOne(
        emoji,
        emojis
          .filter((e) => e.id && e.name)
          .map((e) => ({ id: e.id as string, name: e.name as string, type: "emoji" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single emoji matches "${emoji}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      await rest.patch(Routes.guildEmoji(guildId, resolution.match.id), {
        body: { name },
        reason: "Renamed via Omnicord",
      });
      return ok(`Renamed the emoji to :${name}:.`, {
        id: resolution.match.id,
        name,
      });
    })
  );

  server.registerTool(
    "delete_emoji",
    {
      title: "Delete emoji",
      description:
        "Delete a custom emoji. Safe to call directly: the first call " +
        "changes nothing and returns a preview plus a confirm_token; " +
        "repeating the call with the token deletes it.",
      inputSchema: {
        emoji: z.string().describe("Emoji name or ID."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ emoji, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const emojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
      const resolution = resolveOne(
        emoji,
        emojis
          .filter((e) => e.id && e.name)
          .map((e) => ({ id: e.id as string, name: e.name as string, type: "emoji" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single emoji matches "${emoji}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }

      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [[P.ManageGuildExpressions, "Manage Expressions"]],
        "in this server"
      );

      const gate = gateDestructive({
        tool: "delete_emoji",
        args: { emoji: resolution.match.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the emoji :${resolution.match.name}:. Messages ` +
          "that used it keep a broken reference.",
        previewDetails: { id: resolution.match.id, name: resolution.match.name },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildEmoji(guildId, resolution.match.id), {
        reason: "Deleted via Omnicord",
      });
      return ok(`Deleted the emoji :${resolution.match.name}:.`, {
        deleted: true,
        id: resolution.match.id,
      });
    })
  );
}
