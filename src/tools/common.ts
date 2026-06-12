import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import type {
  APIEmbed,
  APIGuildMember,
  APIMessage,
  RESTGetAPIGuildMembersSearchResult,
} from "discord-api-types/v10";
import { DiscordAPIError, type REST } from "@discordjs/rest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OmnicordConfig } from "../config.js";
import { getRest, NoTokenError } from "../discord/client.js";
import {
  getChannels,
  getGuildList,
  getRoles,
  getBotUser,
  CHANNEL_TYPE_LABELS,
  type GuildChannelLite,
} from "../discord/guildData.js";
import {
  computeChannelPermissions,
  computeGuildPermissions,
} from "../discord/preflight.js";
import { resolveOne } from "../discord/resolve.js";
import { fail } from "../envelope.js";

// Helpers shared by every tool module: guild entry, entity resolution,
// message digesting, and the error guard.

export const guildParam = z
  .string()
  .optional()
  .describe("Guild (server) name or ID. Omit to use the default guild.");

// A failure that already knows how to present itself. Thrown by helpers,
// caught by guarded(), returned to the client as a readable envelope.
export class ToolProblem extends Error {
  result: CallToolResult;
  constructor(result: CallToolResult) {
    super("tool problem");
    this.result = result;
  }
}

// Network failures below the API layer (connection timeouts, resets, DNS
// trouble) are transient and worth a retry; surfacing them as raw stack
// noise leaves the model guessing. Observed live during a flaky-network
// Desktop session as undici ConnectTimeoutErrors.
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const codes = [
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ];
  const code = (err as { code?: string }).code;
  if (code && codes.includes(code)) return true;
  const cause = (err as { cause?: { code?: string; name?: string } }).cause;
  if (cause?.code && codes.includes(cause.code)) return true;
  if (err.name === "ConnectTimeoutError" || cause?.name === "ConnectTimeoutError") {
    return true;
  }
  return /connect timeout|fetch failed/i.test(err.message);
}

export function guarded<A>(
  handler: (args: A) => Promise<CallToolResult>
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof ToolProblem) return err.result;
      if (isNetworkError(err)) {
        return fail(
          "Could not reach Discord: the connection timed out at the " +
            "network level before any API was involved. This is usually " +
            "transient local network or routing trouble; retrying the " +
            "same call typically works.",
          { network_error: true }
        );
      }
      if (err instanceof DiscordAPIError) {
        if (err.status === 403) {
          return fail(
            "Discord refused access (403). The bot is missing a permission " +
              "for this, or cannot see the channel. Check the bot's role " +
              "and the channel's permission overrides.",
            { discord_error: { code: err.code, status: err.status } }
          );
        }
        return fail(`Discord API error ${err.status}: ${err.message}`, {
          discord_error: { code: err.code, status: err.status },
        });
      }
      throw err;
    }
  };
}

export async function enter(
  config: OmnicordConfig,
  guildArg: string | undefined
): Promise<{ rest: REST; guildId: string }> {
  let rest: REST;
  try {
    rest = getRest(config);
  } catch (err) {
    if (err instanceof NoTokenError) throw new ToolProblem(fail(err.message));
    throw err;
  }

  const wanted = guildArg ?? config.defaultGuild;
  if (!wanted) {
    throw new ToolProblem(
      fail(
        "No guild specified and no default configured. Pass a guild name or " +
          "ID, or set OMNICORD_GUILD."
      )
    );
  }

  const guilds = await getGuildList(rest);
  const resolution = resolveOne(
    wanted,
    guilds.map((g) => ({ id: g.id, name: g.name, type: "guild" }))
  );
  if ("match" in resolution) {
    return { rest, guildId: resolution.match.id };
  }
  if (resolution.candidates.length === 0) {
    throw new ToolProblem(
      fail(
        `The bot is not in any guild matching "${wanted}". ` +
          "Check the name, or invite the bot to that server first."
      )
    );
  }
  throw new ToolProblem(
    fail(`Multiple guilds match "${wanted}". Use an exact name or ID.`, {
      candidates: resolution.candidates,
    })
  );
}

export async function resolveChannel(
  rest: REST,
  guildId: string,
  query: string,
  allowedTypes?: number[]
): Promise<GuildChannelLite> {
  const channels = await getChannels(rest, guildId);
  const pool = channels.filter(
    (c) => !allowedTypes || allowedTypes.includes(c.type)
  );
  const resolution = resolveOne(
    query,
    pool.map((c) => ({
      id: c.id,
      name: c.name ?? "",
      type: CHANNEL_TYPE_LABELS[c.type] ?? `type ${c.type}`,
    }))
  );
  if ("match" in resolution) {
    const found = pool.find((c) => c.id === resolution.match.id);
    if (found) return found;
  }

  // Thread fallback: threads never appear in the guild channel list, so
  // a raw ID that did not match gets one direct lookup. Anything in this
  // guild that passes the type filter is accepted, which also covers
  // channels created moments ago that a stale cache missed.
  if (/^\d{17,20}$/.test(query.trim())) {
    try {
      const direct = (await rest.get(
        Routes.channel(query.trim())
      )) as GuildChannelLite & { guild_id?: string };
      if (
        direct.guild_id === guildId &&
        (!allowedTypes || allowedTypes.includes(direct.type))
      ) {
        return direct;
      }
    } catch {
      // Unknown channel; fall through to the normal error.
    }
  }

  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No channel matching "${query}" in this server.`)
      : fail(`Multiple channels match "${query}". Pick one by ID.`, {
          candidates,
        })
  );
}

export function memberDisplayName(member: APIGuildMember): string {
  return (
    member.nick ??
    member.user?.global_name ??
    member.user?.username ??
    "(unknown)"
  );
}

export async function resolveMember(
  rest: REST,
  guildId: string,
  query: string
): Promise<APIGuildMember> {
  const trimmed = query.trim();
  if (/^\d{17,20}$/.test(trimmed)) {
    return (await rest.get(
      Routes.guildMember(guildId, trimmed)
    )) as APIGuildMember;
  }

  const found = (await rest.get(Routes.guildMembersSearch(guildId), {
    query: new URLSearchParams({ query: trimmed, limit: "5" }),
  })) as RESTGetAPIGuildMembersSearchResult;

  if (found.length === 0) {
    throw new ToolProblem(
      fail(`No member matching "${query}" in this server.`)
    );
  }
  if (found.length === 1) return found[0];

  const resolution = resolveOne(
    trimmed,
    found.map((m) => ({
      id: m.user?.id ?? "",
      name: m.user?.username ?? "",
      type: "member",
      context: memberDisplayName(m),
    }))
  );
  if ("match" in resolution) {
    const member = found.find((m) => m.user?.id === resolution.match.id);
    if (member) return member;
  }
  throw new ToolProblem(
    fail(`Multiple members match "${query}". Use a user ID.`, {
      candidates: "candidates" in resolution ? resolution.candidates : [],
    })
  );
}

// Message types that read as system noise get a readable stand-in instead
// of empty content. 7 is the member join notification.
const SYSTEM_CONTENT: Record<number, string> = {
  7: "(joined the server)",
};

export function digestMessage(m: APIMessage) {
  return {
    id: m.id,
    author: {
      id: m.author.id,
      name: m.author.global_name ?? m.author.username,
      bot: m.author.bot ?? false,
    },
    content: m.content || SYSTEM_CONTENT[m.type] || "",
    created_at: m.timestamp,
    edited: Boolean(m.edited_timestamp),
    attachments: (m.attachments ?? []).map((a) => a.filename),
    embeds: (m.embeds ?? []).length,
    reactions: (m.reactions ?? []).map((r) => ({
      emoji: r.emoji.name ?? r.emoji.id ?? "?",
      count: r.count,
    })),
    ...(m.referenced_message
      ? {
          reply_to: {
            id: m.referenced_message.id,
            author:
              m.referenced_message.author.global_name ??
              m.referenced_message.author.username,
            excerpt: (m.referenced_message.content ?? "").slice(0, 80),
          },
        }
      : {}),
  };
}

// Channel types that carry a normal message stream: text, announcement,
// voice text chat, stage text chat, and the three thread kinds.
export const TEXT_BEARING_TYPES = [0, 5, 2, 13, 10, 11, 12];

// The thread kinds by themselves.
export const THREAD_TYPES = [10, 11, 12];

// Effective permissions for the bot itself, guild-wide or in a channel.
export async function botPermissions(
  rest: REST,
  guildId: string,
  channel?: GuildChannelLite
): Promise<bigint> {
  const [botUser, roles] = await Promise.all([
    getBotUser(rest),
    getRoles(rest, guildId),
  ]);
  const member = (await rest.get(
    Routes.guildMember(guildId, botUser.id)
  )) as APIGuildMember;
  if (channel) {
    return computeChannelPermissions(
      botUser.id,
      member.roles,
      guildId,
      roles,
      channel.permission_overwrites ?? []
    );
  }
  return computeGuildPermissions(member.roles, guildId, roles);
}

export function requirePermissions(
  have: bigint,
  needed: Array<[bigint, string]>,
  where: string
): void {
  const missing = needed
    .filter(([bit]) => (have & bit) === 0n)
    .map(([, label]) => label);
  if (missing.length > 0) {
    throw new ToolProblem(
      fail(
        `The bot is missing the ${missing.join(", ")} permission(s) ${where}. ` +
          "Grant them through a role or a channel override, then retry."
      )
    );
  }
}

export function parseHexColor(value: string): number {
  const hex = value.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new ToolProblem(
      fail(`"${value}" is not a hex color. Use the form #5865f2.`)
    );
  }
  return parseInt(hex, 16);
}

// Embed input, shared by send_message and edit_message.
export const embedsParam = z
  .array(
    z.object({
      title: z.string().max(256).optional(),
      description: z.string().max(4096).optional(),
      color: z.string().optional().describe("Hex color like #5865f2."),
      url: z.string().url().optional(),
    })
  )
  .max(10)
  .optional()
  .describe("Up to 10 embeds.");

export type EmbedInput = NonNullable<z.infer<typeof embedsParam>>;

export function mapEmbeds(embeds: EmbedInput): APIEmbed[] {
  return embeds.map((e) => ({
    title: e.title,
    description: e.description,
    url: e.url,
    ...(e.color ? { color: parseHexColor(e.color) } : {}),
  }));
}
