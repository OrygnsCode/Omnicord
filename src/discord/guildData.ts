import type { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type {
  APIRole,
  APIUser,
  RESTGetAPICurrentUserGuildsResult,
} from "discord-api-types/v10";

// Guild structure fetchers with a short TTL cache. Channels and roles get
// read constantly for name resolution but change rarely; thirty seconds of
// staleness is a fine trade against hammering the API on every tool call.

const TTL_MS = 30_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

// The guild channel endpoints return a union type that includes DM shapes
// we can never receive here. This narrow view keeps the rest of the code
// out of cast gymnastics.
export interface GuildChannelLite {
  id: string;
  name: string | null;
  type: number;
  parent_id?: string | null;
  topic?: string | null;
  position?: number;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  permission_overwrites?: Array<{
    id: string;
    type: number;
    allow: string;
    deny: string;
  }>;
}

const channelCache = new Map<string, CacheEntry<GuildChannelLite[]>>();
const roleCache = new Map<string, CacheEntry<APIRole[]>>();
let guildListCache: CacheEntry<RESTGetAPICurrentUserGuildsResult> | undefined;

function fresh<T>(entry: CacheEntry<T> | undefined): T | undefined {
  if (entry && Date.now() - entry.at < TTL_MS) return entry.value;
  return undefined;
}

export async function getChannels(
  rest: REST,
  guildId: string
): Promise<GuildChannelLite[]> {
  const cached = fresh(channelCache.get(guildId));
  if (cached) return cached;
  const value = (await rest.get(
    Routes.guildChannels(guildId)
  )) as GuildChannelLite[];
  channelCache.set(guildId, { at: Date.now(), value });
  return value;
}

export async function getRoles(
  rest: REST,
  guildId: string
): Promise<APIRole[]> {
  const cached = fresh(roleCache.get(guildId));
  if (cached) return cached;
  const value = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
  roleCache.set(guildId, { at: Date.now(), value });
  return value;
}

export async function getGuildList(
  rest: REST
): Promise<RESTGetAPICurrentUserGuildsResult> {
  const cached = fresh(guildListCache);
  if (cached) return cached;
  const value = (await rest.get(
    Routes.userGuilds()
  )) as RESTGetAPICurrentUserGuildsResult;
  guildListCache = { at: Date.now(), value };
  return value;
}

// Write tools call this after creating or changing guild structure so the
// next read sees fresh data instead of a stale cache entry.
export function invalidateGuildCaches(guildId: string): void {
  channelCache.delete(guildId);
  roleCache.delete(guildId);
}

// The bot's own user, cached for an hour. Needed constantly by preflight
// to compute the bot's effective permissions.
let botUserCache: CacheEntry<APIUser> | undefined;
const BOT_USER_TTL_MS = 60 * 60_000;

export async function getBotUser(rest: REST): Promise<APIUser> {
  if (botUserCache && Date.now() - botUserCache.at < BOT_USER_TTL_MS) {
    return botUserCache.value;
  }
  const value = (await rest.get(Routes.user("@me"))) as APIUser;
  botUserCache = { at: Date.now(), value };
  return value;
}

export const CHANNEL_TYPE_LABELS: Record<number, string> = {
  0: "text",
  2: "voice",
  4: "category",
  5: "announcement",
  10: "announcement thread",
  11: "public thread",
  12: "private thread",
  13: "stage",
  15: "forum",
  16: "media",
};
