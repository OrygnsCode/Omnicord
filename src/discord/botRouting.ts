// Multi-bot routing. Given the servers each configured bot can reach, work
// out which bot should act for a requested server. Pure and data-only, so it
// unit-tests without any network or client. The live guild fetching and the
// translation to REST clients happen in the tool entry helper.

import { resolveOne } from "./resolve.js";

export interface BotGuilds {
  name: string;
  guilds: Array<{ id: string; name: string }>;
}

export type BotGuildResolution =
  // Exactly one bot reaches the resolved server.
  | { kind: "match"; botName: string; guildId: string; guildName: string }
  // The server resolved, but more than one of the user's bots is in it, so
  // the acting bot has to be named explicitly.
  | { kind: "ambiguous-bot"; guildId: string; guildName: string; bots: string[] }
  // The name matched more than one server; the user has to be specific.
  | {
      kind: "ambiguous-guild";
      candidates: Array<{ id: string; name: string; bots: string[] }>;
    }
  // No configured bot is in any server matching the request.
  | { kind: "no-guild" };

// Resolve a requested server across every candidate bot. When two bots share
// a server the request is ambiguous by bot; when a name matches two servers
// it is ambiguous by server; anything unambiguous returns the acting bot.
export function resolveBotGuild(
  botGuilds: BotGuilds[],
  wanted: string
): BotGuildResolution {
  // guild id -> its name and the bots that can reach it.
  const byId = new Map<string, { name: string; bots: string[] }>();
  for (const bg of botGuilds) {
    for (const g of bg.guilds) {
      const entry = byId.get(g.id);
      if (entry) {
        if (!entry.bots.includes(bg.name)) entry.bots.push(bg.name);
      } else {
        byId.set(g.id, { name: g.name, bots: [bg.name] });
      }
    }
  }

  const unique = [...byId.entries()].map(([id, v]) => ({
    id,
    name: v.name,
    type: "server",
  }));
  const res = resolveOne(wanted, unique);

  if ("match" in res) {
    const info = byId.get(res.match.id);
    const bots = info?.bots ?? [];
    if (bots.length === 1) {
      return {
        kind: "match",
        botName: bots[0],
        guildId: res.match.id,
        guildName: info?.name ?? res.match.name,
      };
    }
    return {
      kind: "ambiguous-bot",
      guildId: res.match.id,
      guildName: info?.name ?? res.match.name,
      bots,
    };
  }

  if (res.candidates.length === 0) return { kind: "no-guild" };
  return {
    kind: "ambiguous-guild",
    candidates: res.candidates.map((c) => ({
      id: c.id,
      name: c.name,
      bots: byId.get(c.id)?.bots ?? [],
    })),
  };
}

export type BotNameResolution =
  | { kind: "match"; botName: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

// Resolve an explicit bot selector (a name the caller passed) to one of the
// configured bot names.
export function resolveBotName(
  botNames: string[],
  wanted: string
): BotNameResolution {
  const res = resolveOne(
    wanted,
    botNames.map((n) => ({ id: n, name: n, type: "bot" }))
  );
  if ("match" in res) return { kind: "match", botName: res.match.id };
  if (res.candidates.length === 0) return { kind: "none" };
  return { kind: "ambiguous", candidates: res.candidates.map((c) => c.name) };
}
