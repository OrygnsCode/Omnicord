import { z } from "zod";
import {
  Routes,
  PermissionFlagsBits,
  AuditLogEvent,
} from "discord-api-types/v10";
import type {
  APIGuild,
  APIGuildMember,
  RESTGetAPIAuditLogResult,
  RESTGetAPIGuildBansResult,
  RESTPostAPIGuildBulkBanResult,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getRoles, getBotUser } from "../discord/guildData.js";
import {
  computeGuildPermissions,
  highestRolePosition,
  canModerate,
} from "../discord/preflight.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveMember,
  memberDisplayName,
  ToolProblem,
  requirePermissions,
} from "./common.js";

// Moderation tools. Every punitive action (timeout, kick, ban, bulk ban)
// runs the full preflight: bot permission, self and owner protection, and
// strict role hierarchy, all checked before Discord is asked. The
// destructive ones run through the confirmation gate on top.

const P = PermissionFlagsBits;

const SNOWFLAKE = /^\d{17,20}$/;

// Reverse map of audit log event codes to readable snake_case names.
const AUDIT_EVENT_NAMES = new Map<number, string>();
const AUDIT_NAME_CODES = new Map<string, number>();
for (const [key, value] of Object.entries(AuditLogEvent)) {
  if (typeof value === "number") {
    const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    AUDIT_EVENT_NAMES.set(value, snake);
    AUDIT_NAME_CODES.set(snake.replace(/[^a-z0-9]/g, ""), value);
  }
}

function snowflakeToIso(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
}

// Full moderation preflight: permission, then the pure hierarchy rules.
// Returns the resolved target member.
async function preflightModeration(
  rest: Awaited<ReturnType<typeof enter>>["rest"],
  guildId: string,
  memberQuery: string,
  permission: [bigint, string],
  action: string
): Promise<APIGuildMember> {
  const [target, roles, botUser, guildData] = await Promise.all([
    resolveMember(rest, guildId, memberQuery),
    getRoles(rest, guildId),
    getBotUser(rest),
    rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
  ]);
  const botMember = (await rest.get(
    Routes.guildMember(guildId, botUser.id)
  )) as APIGuildMember;

  const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
  requirePermissions(botPerms, [permission], "in this server");

  if (!target.user) {
    throw new ToolProblem(fail(`Could not load member "${memberQuery}".`));
  }
  const verdict = canModerate({
    action,
    targetId: target.user.id,
    targetTopPosition: highestRolePosition(target.roles, roles),
    botId: botUser.id,
    botTopPosition: highestRolePosition(botMember.roles, roles),
    ownerId: guildData.owner_id,
  });
  if (!verdict.ok) {
    throw new ToolProblem(fail(verdict.reason ?? "Moderation not allowed."));
  }
  return target;
}

export function registerModerationTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "timeout_member",
    {
      title: "Timeout member",
      description:
        "Time a member out so they cannot talk, react, or join voice, for " +
        "up to 28 days. Safe to call directly: the first call changes " +
        "nothing and returns a preview plus a confirm_token; repeating the " +
        "call with the token applies the timeout. Relay the preview for " +
        "the user's go-ahead. The reason lands in the audit log.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        duration_minutes: z.number().int().min(1).max(40320)
          .describe("Timeout length in minutes, up to 40320 (28 days)."),
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({
      member,
      guild,
      duration_minutes,
      reason,
      dry_run,
      confirm_token,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await preflightModeration(
        rest,
        guildId,
        member,
        [P.ModerateMembers, "Moderate Members"],
        "timeout"
      );

      const until = new Date(Date.now() + duration_minutes * 60_000);
      const gate = gateDestructive({
        tool: "timeout_member",
        args: { member: target.user!.id, duration_minutes },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would time out ${memberDisplayName(target)} for ` +
          `${duration_minutes} minute(s), until ${until.toISOString()}. ` +
          "They keep reading access but cannot talk, react, or join voice.",
        previewDetails: {
          member: { id: target.user!.id, name: memberDisplayName(target) },
          until: until.toISOString(),
        },
      });
      if (gate) return gate;

      await rest.patch(Routes.guildMember(guildId, target.user!.id), {
        body: { communication_disabled_until: until.toISOString() },
        reason: reason ?? "Timed out via Omnicord",
      });

      return ok(
        `Timed out ${memberDisplayName(target)} until ${until.toISOString()}.`,
        {
          member: { id: target.user!.id, name: memberDisplayName(target) },
          until: until.toISOString(),
        }
      );
    })
  );

  server.registerTool(
    "remove_timeout",
    {
      title: "Remove timeout",
      description: "Lift an active timeout from a member early.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ member, guild, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveMember(rest, guildId, member);
      if (!target.user) return fail(`Could not load member "${member}".`);

      const activelyTimedOut =
        target.communication_disabled_until &&
        new Date(target.communication_disabled_until) > new Date();
      if (!activelyTimedOut) {
        return ok(
          `${memberDisplayName(target)} is not timed out. Nothing to do.`,
          { changed: false }
        );
      }

      await rest.patch(Routes.guildMember(guildId, target.user.id), {
        body: { communication_disabled_until: null },
        reason: reason ?? "Timeout removed via Omnicord",
      });
      return ok(`Removed the timeout from ${memberDisplayName(target)}.`, {
        changed: true,
        member: { id: target.user.id, name: memberDisplayName(target) },
      });
    })
  );

  server.registerTool(
    "kick_member",
    {
      title: "Kick member",
      description:
        "Remove a member from the server. They can rejoin with a new " +
        "invite. Safe to call directly: the first call changes nothing and " +
        "returns a preview plus a confirm_token; repeating the call with " +
        "the token performs the kick. Relay the preview for the user's " +
        "go-ahead instead of doing nothing.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ member, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await preflightModeration(
        rest,
        guildId,
        member,
        [P.KickMembers, "Kick Members"],
        "kick"
      );

      const gate = gateDestructive({
        tool: "kick_member",
        args: { member: target.user!.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would kick ${memberDisplayName(target)} ` +
          `(${target.user!.username}), a member since ${target.joined_at}. ` +
          "Their messages stay; they can rejoin with a new invite.",
        previewDetails: {
          member: { id: target.user!.id, name: memberDisplayName(target) },
          joined_at: target.joined_at,
          role_count: target.roles.length,
        },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildMember(guildId, target.user!.id), {
        reason: reason ?? "Kicked via Omnicord",
      });
      return ok(`Kicked ${memberDisplayName(target)} from the server.`, {
        kicked: true,
        member: { id: target.user!.id, name: memberDisplayName(target) },
      });
    })
  );

  server.registerTool(
    "ban_member",
    {
      title: "Ban member",
      description:
        "Ban a user from the server, optionally deleting their recent " +
        "messages. Works on users who already left (pass their user ID). " +
        "Safe to call directly: the first call changes nothing and returns " +
        "a preview plus a confirm_token; repeating the call with the token " +
        "performs the ban. Relay the preview for the user's go-ahead.",
      inputSchema: {
        user: z.string().describe("Member name, or a user ID for someone not in the server."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        delete_message_seconds: z.number().int().min(0).max(604800).optional()
          .describe("Also delete their messages from the last N seconds, up to 604800 (7 days)."),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({
      user,
      guild,
      reason,
      delete_message_seconds,
      dry_run,
      confirm_token,
    }) => {
      const { rest, guildId } = await enter(config, guild);

      // Resolve the target first. Only a genuine member-not-found with a
      // valid snowflake becomes a hackban (ban in absentia); any other
      // failure, including the protection rejections below, must surface.
      let member: APIGuildMember | undefined;
      try {
        member = await resolveMember(rest, guildId, user);
      } catch (err) {
        if (!(err instanceof ToolProblem) || !SNOWFLAKE.test(user.trim())) {
          throw err;
        }
        member = undefined;
      }

      // Permission and protection checks run on every path. The earlier
      // version skipped both for hackbans, which also let a protected
      // member's raw ID slip past the owner and hierarchy rules.
      const [roles, botUser, guildData] = await Promise.all([
        getRoles(rest, guildId),
        getBotUser(rest),
        rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
      ]);
      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;
      const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
      requirePermissions(botPerms, [[P.BanMembers, "Ban Members"]], "in this server");

      let targetId: string;
      let targetLabel: string;
      let inServer = true;
      if (member?.user) {
        const verdict = canModerate({
          action: "ban",
          targetId: member.user.id,
          targetTopPosition: highestRolePosition(member.roles, roles),
          botId: botUser.id,
          botTopPosition: highestRolePosition(botMember.roles, roles),
          ownerId: guildData.owner_id,
        });
        if (!verdict.ok) return fail(verdict.reason ?? "Ban not allowed.");
        targetId = member.user.id;
        targetLabel = memberDisplayName(member);
      } else {
        // Even in absentia, never the owner.
        if (user.trim() === guildData.owner_id) {
          return fail("The server owner cannot be banned by anyone.");
        }
        targetId = user.trim();
        targetLabel = `user ${targetId}`;
        inServer = false;
      }

      const wipeNote = delete_message_seconds
        ? ` Their messages from the last ${delete_message_seconds} second(s) are deleted too.`
        : "";
      const gate = gateDestructive({
        tool: "ban_member",
        args: { user: targetId, delete_message_seconds: delete_message_seconds ?? 0 },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would ban ${targetLabel}` +
          (inServer ? "" : " (not currently in the server)") +
          `. They cannot rejoin until unbanned.${wipeNote}`,
        previewDetails: {
          user_id: targetId,
          in_server: inServer,
          delete_message_seconds: delete_message_seconds ?? 0,
        },
      });
      if (gate) return gate;

      await rest.put(Routes.guildBan(guildId, targetId), {
        body: delete_message_seconds
          ? { delete_message_seconds }
          : {},
        reason: reason ?? "Banned via Omnicord",
      });
      return ok(`Banned ${targetLabel}.`, { banned: true, user_id: targetId });
    })
  );

  server.registerTool(
    "unban_member",
    {
      title: "Unban member",
      description: "Lift a ban so the user can rejoin with an invite.",
      inputSchema: {
        user_id: z.string().describe("The banned user's ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ user_id, guild, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      if (!SNOWFLAKE.test(user_id.trim())) {
        return fail(
          "unban_member needs a user ID. Find it with list_bans."
        );
      }
      try {
        await rest.delete(Routes.guildBan(guildId, user_id.trim()), {
          reason: reason ?? "Unbanned via Omnicord",
        });
      } catch (err) {
        if (err && typeof err === "object" && "status" in err && err.status === 404) {
          return fail(`User ${user_id} is not banned from this server.`);
        }
        throw err;
      }
      return ok(`Unbanned user ${user_id}. They can rejoin with an invite.`, {
        unbanned: true,
        user_id: user_id.trim(),
      });
    })
  );

  server.registerTool(
    "bulk_ban",
    {
      title: "Bulk ban",
      description:
        "Ban up to 200 users at once by ID, for raid cleanup. Safe to call " +
        "directly: the first call changes nothing and returns a preview " +
        "plus a confirm_token; repeating the call with the token performs " +
        "the bans. Reports which bans succeeded and which failed.",
      inputSchema: {
        user_ids: z.array(z.string().regex(SNOWFLAKE)).min(1).max(200)
          .describe("User IDs to ban."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        delete_message_seconds: z.number().int().min(0).max(604800).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({
      user_ids,
      guild,
      reason,
      delete_message_seconds,
      dry_run,
      confirm_token,
    }) => {
      const { rest, guildId } = await enter(config, guild);

      const [roles, botUser] = await Promise.all([
        getRoles(rest, guildId),
        getBotUser(rest),
      ]);
      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;
      const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
      requirePermissions(
        botPerms,
        [
          [P.BanMembers, "Ban Members"],
          [P.ManageGuild, "Manage Server"],
        ],
        "in this server"
      );

      const ids = [...new Set(user_ids.map((u) => u.trim()))];
      const gate = gateDestructive({
        tool: "bulk_ban",
        args: { user_ids: ids },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would ban ${ids.length} user(s) at once. Hierarchy still ` +
          "applies per user; protected users are reported as failed.",
        previewDetails: { count: ids.length, first_ids: ids.slice(0, 10) },
      });
      if (gate) return gate;

      const result = (await rest.post(Routes.guildBulkBan(guildId), {
        body: {
          user_ids: ids,
          ...(delete_message_seconds ? { delete_message_seconds } : {}),
        },
        reason: reason ?? "Bulk ban via Omnicord",
      })) as RESTPostAPIGuildBulkBanResult;

      return ok(
        `Bulk ban finished: ${result.banned_users.length} banned, ` +
          `${result.failed_users.length} failed.`,
        {
          banned: result.banned_users,
          failed: result.failed_users,
        },
        result.failed_users.length > 0
          ? [
              "Failed entries are usually hierarchy-protected members or " +
                "already-banned users.",
            ]
          : []
      );
    })
  );

  server.registerTool(
    "list_bans",
    {
      title: "List bans",
      description: "Current bans with reasons, paged.",
      inputSchema: {
        guild: guildParam,
        limit: z.number().int().min(1).max(1000).optional()
          .describe("Max entries. Default 50."),
        after: z.string().optional()
          .describe("User ID cursor for paging."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, limit, after }) => {
      const { rest, guildId } = await enter(config, guild);
      const botPerms = await (async () => {
        const [roles, botUser] = await Promise.all([
          getRoles(rest, guildId),
          getBotUser(rest),
        ]);
        const botMember = (await rest.get(
          Routes.guildMember(guildId, botUser.id)
        )) as APIGuildMember;
        return computeGuildPermissions(botMember.roles, guildId, roles);
      })();
      requirePermissions(
        botPerms,
        [[P.BanMembers, "Ban Members"]],
        "in this server"
      );

      const query = new URLSearchParams({ limit: String(limit ?? 50) });
      if (after) query.set("after", after);
      const bans = (await rest.get(Routes.guildBans(guildId), {
        query,
      })) as RESTGetAPIGuildBansResult;

      return ok(`${bans.length} ban(s) on this server.`, {
        bans: bans.map((b) => ({
          user_id: b.user.id,
          username: b.user.username,
          reason: b.reason ?? null,
        })),
        next_after: bans.length > 0 ? bans[bans.length - 1].user.id : null,
      });
    })
  );

  server.registerTool(
    "get_audit_log",
    {
      title: "Get audit log",
      description:
        "Discord's historical record of administrative actions: who did " +
        "what, to what, when, and why. Use this to investigate what already " +
        "happened; for activity as it happens use subscribe_events. Filter " +
        "by action name (like channel_create, member_ban_add, " +
        "message_delete) or by the acting user.",
      inputSchema: {
        guild: guildParam,
        action: z.string().optional()
          .describe("Action name filter, like channel_delete or member_kick."),
        user: z.string().optional()
          .describe("Only entries by this user (name or ID)."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max entries. Default 25."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, action, user, limit }) => {
      const { rest, guildId } = await enter(config, guild);

      const query = new URLSearchParams({ limit: String(limit ?? 25) });
      if (action) {
        const code = AUDIT_NAME_CODES.get(
          action.toLowerCase().replace(/[^a-z0-9]/g, "")
        );
        if (code === undefined) {
          return fail(`Unknown audit action "${action}".`, {
            valid_actions: [...AUDIT_EVENT_NAMES.values()].sort(),
          });
        }
        query.set("action_type", String(code));
      }
      if (user) {
        const member = await resolveMember(rest, guildId, user);
        if (member.user) query.set("user_id", member.user.id);
      }

      const log = (await rest.get(Routes.guildAuditLog(guildId), {
        query,
      })) as RESTGetAPIAuditLogResult;

      const userNames = new Map(
        (log.users ?? []).map((u) => [u.id, u.global_name ?? u.username])
      );
      const entries = (log.audit_log_entries ?? []).map((e) => ({
        action: AUDIT_EVENT_NAMES.get(e.action_type) ?? `event ${e.action_type}`,
        by: e.user_id ? userNames.get(e.user_id) ?? e.user_id : null,
        target_id: e.target_id,
        reason: e.reason ?? null,
        at: snowflakeToIso(e.id),
      }));

      return ok(
        `${entries.length} audit log entr(ies)` +
          (action ? ` for ${action}` : "") +
          ", newest first.",
        { entries }
      );
    })
  );
}
