import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIGuildChannel,
  APIGuildMember,
  APIRole,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import {
  getRoles,
  getChannels,
  getBotUser,
  invalidateGuildCaches,
  CHANNEL_TYPE_LABELS,
  type GuildChannelLite,
} from "../discord/guildData.js";
import {
  computeGuildPermissions,
  highestRolePosition,
} from "../discord/preflight.js";
import { resolveOne } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  botPermissions,
  requirePermissions,
} from "./common.js";

// Structural conveniences: cloning channels and roles, reordering, single
// channel detail, announcement following, and a filtered bulk role apply.

const P = PermissionFlagsBits;

export function registerStructureTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "get_channel",
    {
      title: "Get channel",
      description:
        "Full detail for one channel: type, topic, category, slowmode, " +
        "NSFW flag, and a count of its permission overwrites.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel);
      const channels = await getChannels(rest, guildId);
      const parent = ch.parent_id
        ? channels.find((c) => c.id === ch.parent_id)
        : undefined;
      return ok(
        `${ch.name}: ${CHANNEL_TYPE_LABELS[ch.type] ?? `type ${ch.type}`}` +
          (parent ? ` in ${parent.name}` : "") +
          ".",
        {
          id: ch.id,
          name: ch.name,
          type: CHANNEL_TYPE_LABELS[ch.type] ?? `type ${ch.type}`,
          category: parent ? { id: parent.id, name: parent.name } : null,
          topic: ch.topic ?? null,
          slowmode_seconds: ch.rate_limit_per_user ?? 0,
          nsfw: ch.nsfw ?? false,
          position: ch.position ?? 0,
          overwrite_count: (ch.permission_overwrites ?? []).length,
        }
      );
    })
  );

  server.registerTool(
    "clone_channel",
    {
      title: "Clone channel",
      description:
        "Copy a channel's settings and permission overwrites into a new " +
        "channel in the same category.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID to copy."),
        guild: guildParam,
        new_name: z.string().min(1).max(100).optional()
          .describe("Name for the copy. Defaults to the original plus -copy."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, new_name }) => {
      const { rest, guildId } = await enter(config, guild);
      const src = await resolveChannel(rest, guildId, channel);
      if (src.type === 4) return fail("Clone categories with create_channel instead.");

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], "in this server");

      const full = src as GuildChannelLite & {
        bitrate?: number;
        user_limit?: number;
      };
      const created = (await rest.post(Routes.guildChannels(guildId), {
        body: {
          name: new_name ?? `${src.name}-copy`,
          type: src.type,
          ...(src.parent_id ? { parent_id: src.parent_id } : {}),
          ...(src.topic ? { topic: src.topic } : {}),
          ...(src.rate_limit_per_user
            ? { rate_limit_per_user: src.rate_limit_per_user }
            : {}),
          ...(src.nsfw ? { nsfw: true } : {}),
          ...(full.bitrate ? { bitrate: full.bitrate } : {}),
          ...(full.user_limit ? { user_limit: full.user_limit } : {}),
          ...(src.permission_overwrites
            ? { permission_overwrites: src.permission_overwrites }
            : {}),
        },
        reason: "Cloned via Omnicord",
      })) as APIGuildChannel;
      invalidateGuildCaches(guildId);
      return ok(`Cloned ${src.name} into ${created.name}.`, {
        id: created.id,
        name: created.name,
      });
    })
  );

  server.registerTool(
    "clone_role",
    {
      title: "Clone role",
      description: "Copy a role's permissions, color, and settings into a new role.",
      inputSchema: {
        role: z.string().describe("Role name or ID to copy."),
        guild: guildParam,
        new_name: z.string().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ role, guild, new_name }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const resolution = resolveOne(
        role,
        roles
          .filter((r) => r.id !== guildId)
          .map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }
      const src = roles.find((r) => r.id === resolution.match.id) as APIRole;

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], "in this server");

      const created = (await rest.post(Routes.guildRoles(guildId), {
        body: {
          name: new_name ?? `${src.name} copy`,
          permissions: src.permissions,
          color: src.color,
          hoist: src.hoist,
          mentionable: src.mentionable,
        },
        reason: "Cloned via Omnicord",
      })) as APIRole;
      invalidateGuildCaches(guildId);
      return ok(`Cloned role ${src.name} into ${created.name}.`, {
        id: created.id,
        name: created.name,
      });
    })
  );

  server.registerTool(
    "reorder_channels",
    {
      title: "Reorder channels",
      description:
        "Move channels to new positions, and optionally into a different " +
        "category, in one call.",
      inputSchema: {
        guild: guildParam,
        moves: z
          .array(
            z.object({
              channel: z.string().describe("Channel name or ID."),
              position: z.number().int().min(0),
              category: z.string().optional()
                .describe("Move under this category, or none for top level."),
            })
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, moves }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], "in this server");

      const body = [];
      for (const move of moves) {
        const ch = await resolveChannel(rest, guildId, move.channel);
        const entry: Record<string, unknown> = { id: ch.id, position: move.position };
        if (move.category !== undefined) {
          entry.parent_id =
            move.category.toLowerCase() === "none"
              ? null
              : (await resolveChannel(rest, guildId, move.category, [4])).id;
        }
        body.push(entry);
      }
      await rest.patch(Routes.guildChannels(guildId), {
        body,
        reason: "Reordered via Omnicord",
      });
      invalidateGuildCaches(guildId);
      return ok(`Reordered ${moves.length} channel(s).`, { moved: moves.length });
    })
  );

  server.registerTool(
    "reorder_roles",
    {
      title: "Reorder roles",
      description:
        "Move roles to new hierarchy positions in one call. Higher " +
        "positions sit higher in the list and outrank lower ones.",
      inputSchema: {
        guild: guildParam,
        moves: z
          .array(
            z.object({
              role: z.string().describe("Role name or ID."),
              position: z.number().int().min(1),
            })
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, moves }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], "in this server");

      const body = [];
      for (const move of moves) {
        const resolution = resolveOne(
          move.role,
          roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
        );
        if (!("match" in resolution)) {
          return fail(`No single role matches "${move.role}".`);
        }
        body.push({ id: resolution.match.id, position: move.position });
      }
      await rest.patch(Routes.guildRoles(guildId), {
        body,
        reason: "Reordered via Omnicord",
      });
      invalidateGuildCaches(guildId);
      return ok(`Reordered ${moves.length} role(s).`, { moved: moves.length });
    })
  );

  server.registerTool(
    "follow_announcement_channel",
    {
      title: "Follow announcement channel",
      description:
        "Subscribe a channel to an announcement channel, so crossposted " +
        "messages from the source appear in the target.",
      inputSchema: {
        guild: guildParam,
        source: z.string().describe("Announcement channel name or ID to follow."),
        target: z.string().describe("Channel where its posts should appear."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, source, target }) => {
      const { rest, guildId } = await enter(config, guild);
      const src = await resolveChannel(rest, guildId, source, [5]);
      const dest = await resolveChannel(rest, guildId, target, [0, 5]);
      const perms = await botPermissions(rest, guildId, dest);
      requirePermissions(perms, [[P.ManageWebhooks, "Manage Webhooks"]], `in #${dest.name}`);

      await rest.post(Routes.channelFollowers(src.id), {
        body: { webhook_channel_id: dest.id },
        reason: "Followed via Omnicord",
      });
      return ok(`#${dest.name} now follows announcements from #${src.name}.`, {
        source: src.id,
        target: dest.id,
      });
    })
  );

  server.registerTool(
    "bulk_update_roles",
    {
      title: "Bulk update roles",
      description:
        "Add or remove a role across every member matching a filter. " +
        "Safe to call directly: the first call returns the affected count " +
        "and a confirm_token; repeating the call with the token applies " +
        "the change. Walks up to 3000 members and reports if it hits the cap.",
      inputSchema: {
        guild: guildParam,
        action: z.enum(["assign", "remove"]),
        role: z.string().describe("Role name or ID."),
        filter: z
          .object({
            has_role: z.string().optional().describe("Members holding this role."),
            is_bot: z.boolean().optional(),
            joined_before: z.string().optional().describe("ISO date."),
            joined_after: z.string().optional().describe("ISO date."),
          })
          .optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ guild, action, role, filter, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const botUser = await getBotUser(rest);
      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;
      const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
      requirePermissions(botPerms, [[P.ManageRoles, "Manage Roles"]], "in this server");

      const resolution = resolveOne(
        role,
        roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`);
      }
      const targetRole = roles.find((r) => r.id === resolution.match.id) as APIRole;
      const botTop = highestRolePosition(botMember.roles, roles);
      if (targetRole.position > botTop) {
        return fail(
          `${targetRole.name} is above the bot's highest role, so the bot ` +
            "cannot manage it. Move the bot's role higher."
        );
      }

      let hasRoleId: string | undefined;
      if (filter?.has_role) {
        const hr = resolveOne(
          filter.has_role,
          roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
        );
        if (!("match" in hr)) return fail(`No single role matches "${filter.has_role}".`);
        hasRoleId = hr.match.id;
      }
      const before = filter?.joined_before ? new Date(filter.joined_before).getTime() : undefined;
      const after = filter?.joined_after ? new Date(filter.joined_after).getTime() : undefined;

      // Walk members up to the cap, applying filters.
      const matched: APIGuildMember[] = [];
      let walkAfter: string | undefined;
      let hitCap = false;
      for (let page = 0; page < 3; page += 1) {
        const params = new URLSearchParams({ limit: "1000" });
        if (walkAfter) params.set("after", walkAfter);
        const batch = (await rest.get(Routes.guildMembers(guildId), {
          query: params,
        })) as APIGuildMember[];
        for (const m of batch) {
          if (!m.user) continue;
          if (filter?.is_bot !== undefined && (m.user.bot ?? false) !== filter.is_bot) continue;
          if (hasRoleId && !m.roles.includes(hasRoleId)) continue;
          const joined = m.joined_at ? new Date(m.joined_at).getTime() : 0;
          if (before !== undefined && joined >= before) continue;
          if (after !== undefined && joined <= after) continue;
          const alreadyHas = m.roles.includes(targetRole.id);
          if (action === "assign" && alreadyHas) continue;
          if (action === "remove" && !alreadyHas) continue;
          matched.push(m);
        }
        if (batch.length < 1000) break;
        walkAfter = batch[batch.length - 1]?.user?.id;
        if (page === 2) hitCap = true;
      }

      const warnings = hitCap
        ? ["Stopped after scanning 3000 members; larger servers need paging."]
        : [];

      const gate = gateDestructive({
        tool: "bulk_update_roles",
        args: { guild: guildId, action, role: targetRole.id, count: matched.length },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would ${action} the role ${targetRole.name} ` +
          `${action === "assign" ? "to" : "from"} ${matched.length} member(s).`,
        previewDetails: {
          action,
          role: targetRole.name,
          count: matched.length,
          sample: matched.slice(0, 10).map((m) => m.user?.username),
        },
      });
      if (gate) return gate;

      let done = 0;
      for (const m of matched) {
        if (!m.user) continue;
        try {
          if (action === "assign") {
            await rest.put(Routes.guildMemberRole(guildId, m.user.id, targetRole.id), {
              reason: "Bulk role via Omnicord",
            });
          } else {
            await rest.delete(Routes.guildMemberRole(guildId, m.user.id, targetRole.id), {
              reason: "Bulk role via Omnicord",
            });
          }
          done += 1;
        } catch {
          // Skip individuals that fail (left the server mid-run, etc.).
        }
      }

      return ok(
        `${action === "assign" ? "Assigned" : "Removed"} ${targetRole.name} ` +
          `${action === "assign" ? "to" : "from"} ${done} member(s).`,
        { action, role: targetRole.name, affected: done },
        warnings
      );
    })
  );
}
