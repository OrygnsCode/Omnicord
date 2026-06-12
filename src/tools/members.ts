import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIGuildMember, APIRole } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getRoles, getBotUser, getChannels } from "../discord/guildData.js";
import {
  computeGuildPermissions,
  computeChannelPermissions,
  highestRolePosition,
  describePermissions,
  ALL_PERMISSIONS,
} from "../discord/preflight.js";
import { voiceMembersIn, hasGuildVoiceData } from "../discord/voiceState.js";
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

// Member administration: nickname and voice state edits, removing a role,
// effective-permission inspection, and who is in a voice channel.

const P = PermissionFlagsBits;

export function registerMemberTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "update_member",
    {
      title: "Update member",
      description:
        "Edit a member's nickname or voice state. Voice changes (server " +
        "mute, server deafen, move to another voice channel) only apply " +
        "while the member is connected to voice. Role changes go through " +
        "assign_role and remove_role.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        nickname: z.string().max(32).optional()
          .describe("New nickname, or empty string to clear it."),
        server_mute: z.boolean().optional(),
        server_deafen: z.boolean().optional(),
        move_to_voice: z.string().optional()
          .describe("Voice channel name or ID to move the member into."),
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      member,
      guild,
      nickname,
      server_mute,
      server_deafen,
      move_to_voice,
      reason,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveMember(rest, guildId, member);
      if (!target.user) return fail(`Could not load member "${member}".`);

      if (
        nickname === undefined &&
        server_mute === undefined &&
        server_deafen === undefined &&
        move_to_voice === undefined
      ) {
        return fail("Pass at least one field to change.");
      }

      const botUser = await getBotUser(rest);
      const isSelf = target.user.id === botUser.id;

      // The bot changing its own nickname goes through the current-member
      // endpoint and needs only Change Nickname; the general member-modify
      // endpoint refuses a self nickname. Voice state on the bot itself is
      // meaningless since the bot is not in voice.
      if (isSelf && nickname !== undefined) {
        requirePermissions(
          await botPermissions(rest, guildId),
          [[P.ChangeNickname, "Change Nickname"]],
          "in this server"
        );
        await rest.patch(Routes.guildMember(guildId, "@me"), {
          body: { nick: nickname },
          reason: reason ?? "Updated via Omnicord",
        });
        return ok(
          `Updated the bot's nickname` +
            (nickname === "" ? " (cleared)." : ` to "${nickname}".`),
          {
            member: { id: botUser.id, name: "the bot" },
            changed: [nickname === "" ? "nickname cleared" : `nickname to "${nickname}"`],
          }
        );
      }

      const perms = await botPermissions(rest, guildId);
      const changes: string[] = [];
      const body: Record<string, unknown> = {};
      if (nickname !== undefined) {
        requirePermissions(perms, [[P.ManageNicknames, "Manage Nicknames"]], "in this server");
        body.nick = nickname;
        changes.push(nickname === "" ? "nickname cleared" : `nickname to "${nickname}"`);
      }
      if (server_mute !== undefined) {
        requirePermissions(perms, [[P.MuteMembers, "Mute Members"]], "in this server");
        body.mute = server_mute;
        changes.push(server_mute ? "server muted" : "server unmuted");
      }
      if (server_deafen !== undefined) {
        requirePermissions(perms, [[P.DeafenMembers, "Deafen Members"]], "in this server");
        body.deaf = server_deafen;
        changes.push(server_deafen ? "server deafened" : "server undeafened");
      }
      if (move_to_voice !== undefined) {
        requirePermissions(perms, [[P.MoveMembers, "Move Members"]], "in this server");
        const channel = await resolveChannel(rest, guildId, move_to_voice, [2, 13]);
        body.channel_id = channel.id;
        changes.push(`moved to ${channel.name}`);
      }

      await rest.patch(Routes.guildMember(guildId, target.user.id), {
        body,
        reason: reason ?? "Updated via Omnicord",
      });
      return ok(`Updated ${memberDisplayName(target)}: ${changes.join(", ")}.`, {
        member: { id: target.user.id, name: memberDisplayName(target) },
        changed: changes,
      });
    })
  );

  server.registerTool(
    "disconnect_member",
    {
      title: "Disconnect member from voice",
      description:
        "Remove a member from whatever voice channel they are in. They " +
        "stay in the server; only the voice connection ends.",
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

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.MoveMembers, "Move Members"]], "in this server");

      await rest.patch(Routes.guildMember(guildId, target.user.id), {
        body: { channel_id: null },
        reason: reason ?? "Disconnected via Omnicord",
      });
      return ok(`Disconnected ${memberDisplayName(target)} from voice.`, {
        member: { id: target.user.id, name: memberDisplayName(target) },
      });
    })
  );

  server.registerTool(
    "list_voice_members",
    {
      title: "List voice members",
      description:
        "Who is currently in a voice or stage channel, with their mute " +
        "and deafen state. This reads the live voice presence the gateway " +
        "tracks, so it reflects the time since Omnicord connected.",
      inputSchema: {
        channel: z.string().describe("Voice or stage channel name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, [2, 13]);

      const warnings: string[] = [];
      if (!hasGuildVoiceData(guildId)) {
        warnings.push(
          "The gateway has not yet reported voice state for this server; " +
            "results may be incomplete until it has been connected briefly."
        );
      }

      const members = voiceMembersIn(guildId, target.id);
      return ok(
        `${members.length} member(s) in ${target.name}.`,
        {
          channel: { id: target.id, name: target.name },
          members: members.map((m) => ({
            id: m.user_id,
            name: m.nick ?? m.username ?? m.user_id,
            muted: m.self_mute || m.server_mute,
            deafened: m.self_deaf || m.server_deaf,
          })),
        },
        warnings
      );
    })
  );

  server.registerTool(
    "remove_role",
    {
      title: "Remove role",
      description:
        "Take a role away from a member. Preflights the bot's role " +
        "hierarchy so a failure is an explanation, not a 403.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ member, role, guild, reason }) => {
      const { rest, guildId } = await enter(config, guild);
      const [target, roles, botUser] = await Promise.all([
        resolveMember(rest, guildId, member),
        getRoles(rest, guildId),
        getBotUser(rest),
      ]);
      if (!target.user) return fail(`Could not load member "${member}".`);

      const resolution = resolveOne(
        role,
        roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }
      const targetRole = roles.find((r) => r.id === resolution.match.id) as APIRole;
      if (!target.roles.includes(targetRole.id)) {
        return ok(
          `${memberDisplayName(target)} does not have ${targetRole.name}. ` +
            "Nothing to do.",
          { already_absent: true }
        );
      }
      if (targetRole.managed) {
        return fail(`${targetRole.name} is integration-managed and cannot be removed manually.`);
      }

      const botMember = (await rest.get(
        Routes.guildMember(guildId, botUser.id)
      )) as APIGuildMember;
      const botPerms = computeGuildPermissions(botMember.roles, guildId, roles);
      requirePermissions(botPerms, [[P.ManageRoles, "Manage Roles"]], "in this server");
      const botTop = highestRolePosition(botMember.roles, roles);
      const warnings: string[] = [];
      if (targetRole.position > botTop) {
        return fail(
          `The bot's highest role (position ${botTop}) is below ` +
            `${targetRole.name} (position ${targetRole.position}). Discord ` +
            "will reject this. Move the bot's role higher."
        );
      }
      if (targetRole.position === botTop) {
        warnings.push(
          "The target role shares the bot's highest position; Discord may " +
            "reject the change."
        );
      }

      await rest.delete(
        Routes.guildMemberRole(guildId, target.user.id, targetRole.id),
        { reason: reason ?? "Removed via Omnicord" }
      );
      return ok(
        `Removed ${targetRole.name} from ${memberDisplayName(target)}.`,
        {
          member: { id: target.user.id, name: memberDisplayName(target) },
          role: { id: targetRole.id, name: targetRole.name },
        },
        warnings
      );
    })
  );

  server.registerTool(
    "get_member_permissions",
    {
      title: "Get member permissions",
      description:
        "The effective permissions a member has, server-wide or in a " +
        "specific channel once role and overwrite resolution is applied, " +
        "in plain language.",
      inputSchema: {
        member: z.string().describe("Member name or user ID."),
        guild: guildParam,
        channel: z.string().optional()
          .describe("Resolve permissions in this channel instead of server-wide."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ member, guild, channel }) => {
      const { rest, guildId } = await enter(config, guild);
      const [target, roles] = await Promise.all([
        resolveMember(rest, guildId, member),
        getRoles(rest, guildId),
      ]);
      if (!target.user) return fail(`Could not load member "${member}".`);

      let bits: bigint;
      let scope: string;
      if (channel) {
        const ch = await resolveChannel(rest, guildId, channel);
        bits = computeChannelPermissions(
          target.user.id,
          target.roles,
          guildId,
          roles,
          ch.permission_overwrites ?? []
        );
        scope = `in #${ch.name}`;
      } else {
        bits = computeGuildPermissions(target.roles, guildId, roles);
        scope = "server-wide";
      }

      const isAdmin = bits === ALL_PERMISSIONS;
      return ok(
        `${memberDisplayName(target)} ${scope}: ` +
          (isAdmin
            ? "administrator (every permission)."
            : `${describePermissions(bits).length} permission(s).`),
        {
          member: { id: target.user.id, name: memberDisplayName(target) },
          scope,
          administrator: isAdmin,
          permissions: describePermissions(bits),
        }
      );
    })
  );
}
