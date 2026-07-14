import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type {
  APIGuildMember,
  RESTGetAPICurrentUserGuildsResult,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getRoles } from "../discord/guildData.js";
import { getRestForToken, NoTokenError } from "../discord/client.js";
import { resolveOne } from "../discord/resolve.js";
import { ok, fail } from "../envelope.js";
import { enter, guarded, guildParam, memberDisplayName } from "./common.js";

// Roster reads: the servers the bot is in, a paged member list, and the
// members holding a role. search_members covers name and filter search;
// these cover the plain enumerations.

export function registerRosterTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "list_servers",
    {
      title: "List servers",
      description:
        "Every server your bots are in, each labeled with which bot reaches " +
        "it, with approximate member counts. When more than one bot is " +
        "configured this is the map for choosing which one acts. Use " +
        "get_server_overview for one server's full detail.",
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      if (config.bots.length === 0) {
        return fail(new NoTokenError().message);
      }
      const perBot = await Promise.all(
        config.bots.map(async (bot) => {
          const rest = getRestForToken(bot.token);
          const guilds = (await rest.get(Routes.userGuilds(), {
            query: new URLSearchParams({ with_counts: "true" }),
          })) as RESTGetAPICurrentUserGuildsResult;
          return { bot, guilds };
        })
      );
      const servers = perBot.flatMap(({ bot, guilds }) =>
        guilds.map((g) => ({
          id: g.id,
          name: g.name,
          members_approximate:
            (g as { approximate_member_count?: number }).approximate_member_count ?? null,
          owner: g.owner ?? false,
          bot: bot.name,
        }))
      );
      const uniqueServers = new Set(servers.map((s) => s.id)).size;
      const summary =
        config.bots.length === 1
          ? `The bot is in ${servers.length} server(s).`
          : `${config.bots.length} bots across ${uniqueServers} server(s).`;
      return ok(summary, {
        bots: config.bots.map((b) => ({ name: b.name, default: b.isDefault })),
        servers,
      });
    })
  );

  server.registerTool(
    "list_members",
    {
      title: "List members",
      description:
        "A paged roster of server members. Pass after with the last id to " +
        "continue. For finding specific people, search_members is better.",
      inputSchema: {
        guild: guildParam,
        limit: z.number().int().min(1).max(1000).optional()
          .describe("How many, up to 1000. Default 100."),
        after: z.string().optional().describe("User id cursor to page past."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, limit, after }) => {
      const { rest, guildId } = await enter(config, guild);
      const params = new URLSearchParams({ limit: String(limit ?? 100) });
      if (after) params.set("after", after);
      const members = (await rest.get(Routes.guildMembers(guildId), {
        query: params,
      })) as APIGuildMember[];
      return ok(`${members.length} member(s).`, {
        members: members.map((m) => ({
          id: m.user?.id,
          name: m.user?.username,
          display_name: memberDisplayName(m),
          bot: m.user?.bot ?? false,
          joined_at: m.joined_at,
        })),
        next_after: members.length > 0 ? members[members.length - 1].user?.id : null,
      });
    })
  );

  server.registerTool(
    "get_role_members",
    {
      title: "Get role members",
      description: "The members who currently hold a given role.",
      inputSchema: {
        role: z.string().describe("Role name or ID."),
        guild: guildParam,
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max results. Default 50."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ role, guild, limit }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const resolution = resolveOne(
        role,
        roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
      );
      if (!("match" in resolution)) {
        return fail(`No single role matches "${role}".`, {
          candidates: "candidates" in resolution ? resolution.candidates : [],
        });
      }
      const roleId = resolution.match.id;

      const holders: APIGuildMember[] = [];
      let after: string | undefined;
      const max = limit ?? 50;
      for (let page = 0; page < 3 && holders.length < max; page += 1) {
        const params = new URLSearchParams({ limit: "1000" });
        if (after) params.set("after", after);
        const batch = (await rest.get(Routes.guildMembers(guildId), {
          query: params,
        })) as APIGuildMember[];
        for (const m of batch) {
          if (m.roles.includes(roleId)) holders.push(m);
        }
        if (batch.length < 1000) break;
        after = batch[batch.length - 1]?.user?.id;
      }

      return ok(
        `${holders.length} member(s) hold ${resolution.match.name}.`,
        {
          role: { id: roleId, name: resolution.match.name },
          members: holders.slice(0, max).map((m) => ({
            id: m.user?.id,
            name: m.user?.username,
            display_name: memberDisplayName(m),
          })),
        }
      );
    })
  );
}
