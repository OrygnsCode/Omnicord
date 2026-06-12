import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIGuildMember, APIRole } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getRoles, getBotUser, invalidateGuildCaches } from "../discord/guildData.js";
import {
  computeChannelPermissions,
  computeGuildPermissions,
  parsePermissionNames,
  describePermissions,
  listPermissionNames,
  type OverwriteLite,
} from "../discord/preflight.js";
import { resolveOne } from "../discord/resolve.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  resolveMember,
  memberDisplayName,
  botPermissions,
  requirePermissions,
} from "./common.js";

// Standalone channel permission management: read, set, and clear
// overwrites; lock and unlock a channel; and explain why an actor can or
// cannot do something. The builder compiles overwrites during a build;
// these tools manage them piecemeal afterward.

const P = PermissionFlagsBits;
const SEND_FAMILY = P.SendMessages | P.SendMessagesInThreads;

// Resolves a permission target to its overwrite id and type (0 role, 1
// member), accepting role or member references.
async function resolveOverwriteTarget(
  rest: REST,
  guildId: string,
  ref: string
): Promise<{ id: string; type: 0 | 1; label: string }> {
  const roles = await getRoles(rest, guildId);
  const roleMatch = resolveOne(
    ref,
    roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
  );
  if ("match" in roleMatch) {
    return { id: roleMatch.match.id, type: 0, label: `role ${roleMatch.match.name}` };
  }
  const member = await resolveMember(rest, guildId, ref);
  if (member.user) {
    return { id: member.user.id, type: 1, label: `member ${memberDisplayName(member)}` };
  }
  throw new Error(`Could not resolve "${ref}" to a role or member.`);
}

export function registerPermissionTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "get_channel_permissions",
    {
      title: "Get channel permissions",
      description:
        "The permission overwrites on a channel, resolved into plain " +
        "language per role and member.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel);
      const roles = await getRoles(rest, guildId);
      const roleNames = new Map(roles.map((r) => [r.id, r.name]));

      const overwrites = (target.permission_overwrites ?? []).map((ow) => ({
        target:
          ow.type === 0
            ? `role ${ow.id === guildId ? "@everyone" : roleNames.get(ow.id) ?? ow.id}`
            : `member ${ow.id}`,
        allow: describePermissions(BigInt(ow.allow)),
        deny: describePermissions(BigInt(ow.deny)),
      }));

      return ok(
        `${overwrites.length} permission overwrite(s) on ${target.name}.`,
        { channel: { id: target.id, name: target.name }, overwrites }
      );
    })
  );

  server.registerTool(
    "set_channel_permissions",
    {
      title: "Set channel permissions",
      description:
        "Set a permission overwrite on a channel for one role or member: " +
        "which permissions are explicitly allowed and which are denied. " +
        "Permission names like manage_messages or send_messages.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        target: z.string().describe("Role or member name or ID."),
        allow: z.array(z.string()).optional().describe("Permissions to allow."),
        deny: z.array(z.string()).optional().describe("Permissions to deny."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, target, allow, deny }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel);
      if (!allow?.length && !deny?.length) {
        return fail("Pass allow and/or deny permission names.");
      }

      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${ch.name}`);

      const allowParsed = parsePermissionNames(allow ?? []);
      const denyParsed = parsePermissionNames(deny ?? []);
      const unknown = [...allowParsed.unknown, ...denyParsed.unknown];
      if (unknown.length > 0) {
        return fail(`Unknown permission name(s): ${unknown.join(", ")}.`, {
          valid_names: listPermissionNames(),
        });
      }

      const resolved = await resolveOverwriteTarget(rest, guildId, target);
      await rest.put(Routes.channelPermission(ch.id, resolved.id), {
        body: {
          type: resolved.type,
          allow: allowParsed.bits.toString(),
          deny: denyParsed.bits.toString(),
        },
        reason: "Overwrite set via Omnicord",
      });
      invalidateGuildCaches(guildId);

      return ok(
        `Set the overwrite for ${resolved.label} on ${ch.name}.`,
        {
          channel: { id: ch.id, name: ch.name },
          target: resolved.label,
          allow: describePermissions(allowParsed.bits),
          deny: describePermissions(denyParsed.bits),
        }
      );
    })
  );

  server.registerTool(
    "clear_channel_permissions",
    {
      title: "Clear channel permissions",
      description:
        "Remove a role's or member's permission overwrite from a channel, " +
        "restoring inheritance from the category and roles.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        target: z.string().describe("Role or member name or ID."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, target }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${ch.name}`);

      const resolved = await resolveOverwriteTarget(rest, guildId, target);
      await rest.delete(Routes.channelPermission(ch.id, resolved.id), {
        reason: "Overwrite cleared via Omnicord",
      });
      invalidateGuildCaches(guildId);
      return ok(`Cleared the overwrite for ${resolved.label} on ${ch.name}.`, {
        cleared: true,
      });
    })
  );

  server.registerTool(
    "lock_channel",
    {
      title: "Lock channel",
      description:
        "Lock a channel by denying everyone the ability to send messages. " +
        "Existing role overwrites that allow posting still apply, so " +
        "moderators keep access. Reverse with unlock_channel.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel, [0, 5, 15]);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${ch.name}`);

      const everyone = (ch.permission_overwrites ?? []).find(
        (o) => o.type === 0 && o.id === guildId
      );
      const allow = BigInt(everyone?.allow ?? 0);
      const deny = BigInt(everyone?.deny ?? 0) | SEND_FAMILY;
      await rest.put(Routes.channelPermission(ch.id, guildId), {
        body: { type: 0, allow: allow.toString(), deny: deny.toString() },
        reason: reason ?? "Locked via Omnicord",
      });
      invalidateGuildCaches(guildId);
      return ok(`Locked #${ch.name}; everyone is denied sending messages.`, {
        locked: true,
        channel: { id: ch.id, name: ch.name },
      });
    })
  );

  server.registerTool(
    "unlock_channel",
    {
      title: "Unlock channel",
      description:
        "Reverse lock_channel by removing the send-message denial from the " +
        "everyone overwrite.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const ch = await resolveChannel(rest, guildId, channel, [0, 5, 15]);
      const perms = await botPermissions(rest, guildId, ch);
      requirePermissions(perms, [[P.ManageRoles, "Manage Roles"]], `on ${ch.name}`);

      const everyone = (ch.permission_overwrites ?? []).find(
        (o) => o.type === 0 && o.id === guildId
      );
      const allow = BigInt(everyone?.allow ?? 0);
      const deny = BigInt(everyone?.deny ?? 0) & ~SEND_FAMILY;
      await rest.put(Routes.channelPermission(ch.id, guildId), {
        body: { type: 0, allow: allow.toString(), deny: deny.toString() },
        reason: reason ?? "Unlocked via Omnicord",
      });
      invalidateGuildCaches(guildId);
      return ok(`Unlocked #${ch.name}.`, {
        locked: false,
        channel: { id: ch.id, name: ch.name },
      });
    })
  );

  server.registerTool(
    "explain_permissions",
    {
      title: "Explain permissions",
      description:
        "Answer whether an actor (the bot, or a member) has a given " +
        "permission, server-wide or in a channel, and explain the result " +
        "through the role and overwrite chain. The preflight engine, made " +
        "directly askable.",
      inputSchema: {
        actor: z.string().describe('A member name or ID, or "bot".'),
        permission: z.string().describe("Permission name, like manage_messages."),
        guild: guildParam,
        channel: z.string().optional()
          .describe("Check in this channel instead of server-wide."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ actor, permission, guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);

      const parsed = parsePermissionNames([permission]);
      if (parsed.unknown.length > 0) {
        return fail(`Unknown permission "${permission}".`, {
          valid_names: listPermissionNames(),
        });
      }
      const wanted = parsed.bits;

      let actorId: string;
      let actorRoleIds: string[];
      let actorLabel: string;
      if (actor.toLowerCase() === "bot") {
        const botUser = await getBotUser(rest);
        const botMember = (await rest.get(
          Routes.guildMember(guildId, botUser.id)
        )) as APIGuildMember;
        actorId = botUser.id;
        actorRoleIds = botMember.roles;
        actorLabel = "the bot";
      } else {
        const member = await resolveMember(rest, guildId, actor);
        if (!member.user) return fail(`Could not load member "${actor}".`);
        actorId = member.user.id;
        actorRoleIds = member.roles;
        actorLabel = memberDisplayName(member);
      }

      let effective: bigint;
      let scope: string;
      let overwrites: OverwriteLite[] = [];
      if (channel) {
        const ch = await resolveChannel(rest, guildId, channel);
        overwrites = (ch.permission_overwrites ?? []) as OverwriteLite[];
        effective = computeChannelPermissions(actorId, actorRoleIds, guildId, roles, overwrites);
        scope = `in #${ch.name}`;
      } else {
        effective = computeGuildPermissions(actorRoleIds, guildId, roles);
        scope = "server-wide";
      }

      const has = (effective & wanted) === wanted;
      const isAdmin =
        (computeGuildPermissions(actorRoleIds, guildId, roles) & P.Administrator) !== 0n;

      let reason: string;
      if (has && isAdmin) {
        reason = "Administrator grants every permission.";
      } else if (has) {
        reason = `A role or channel overwrite grants ${permission} ${scope}.`;
      } else {
        reason =
          `No role grants ${permission}` +
          (channel ? " and no channel overwrite adds it" : "") +
          (channel ? ", or an overwrite denies it." : ".");
      }

      return ok(
        `${actorLabel} ${has ? "has" : "does not have"} ${permission} ${scope}. ${reason}`,
        { actor: actorLabel, permission, scope, allowed: has, administrator: isAdmin }
      );
    })
  );
}
