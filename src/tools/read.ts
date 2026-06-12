import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIGuild,
  APIGuildMember,
  APIMessage,
  RESTGetAPIGuildMembersSearchResult,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import {
  getChannels,
  getRoles,
  CHANNEL_TYPE_LABELS,
} from "../discord/guildData.js";
import { resolveOne, type Resolvable } from "../discord/resolve.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  resolveMember,
  memberDisplayName,
  digestMessage,
  TEXT_BEARING_TYPES,
} from "./common.js";

// Read-only tools: the Phase 1 core. Everything in this file can be called
// freely; nothing here changes any state on Discord.

// Roles whose permission digests are worth surfacing. The full bitfield is
// sixty-plus flags of noise; these are the ones a human asks about.
const KEY_PERMISSIONS: Array<[bigint, string]> = [
  [PermissionFlagsBits.Administrator, "administrator"],
  [PermissionFlagsBits.ManageGuild, "manage server"],
  [PermissionFlagsBits.ManageRoles, "manage roles"],
  [PermissionFlagsBits.ManageChannels, "manage channels"],
  [PermissionFlagsBits.ManageMessages, "manage messages"],
  [PermissionFlagsBits.ManageWebhooks, "manage webhooks"],
  [PermissionFlagsBits.KickMembers, "kick members"],
  [PermissionFlagsBits.BanMembers, "ban members"],
  [PermissionFlagsBits.ModerateMembers, "timeout members"],
  [PermissionFlagsBits.MentionEveryone, "mention everyone"],
];

function permissionDigest(bitfield: string): string[] {
  const bits = BigInt(bitfield);
  if ((bits & PermissionFlagsBits.Administrator) !== 0n) {
    return ["administrator (implies everything)"];
  }
  return KEY_PERMISSIONS.filter(([bit]) => (bits & bit) !== 0n).map(
    ([, label]) => label
  );
}

export function registerReadTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "get_server_overview",
    {
      title: "Get server overview",
      description:
        "Structured snapshot of a server: identity, member counts, boost " +
        "status, channel outline grouped by category, and role count. The " +
        "natural first call when starting work on a server.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const [guildData, channels] = await Promise.all([
        rest.get(Routes.guild(guildId), {
          query: new URLSearchParams({ with_counts: "true" }),
        }) as Promise<APIGuild>,
        getChannels(rest, guildId),
      ]);

      const byType: Record<string, number> = {};
      for (const c of channels) {
        const label = CHANNEL_TYPE_LABELS[c.type] ?? `type ${c.type}`;
        byType[label] = (byType[label] ?? 0) + 1;
      }

      const categories = channels
        .filter((c) => c.type === 4)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((cat) => ({
          id: cat.id,
          name: cat.name,
          channels: channels
            .filter((c) => c.parent_id === cat.id)
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            .map((c) => ({
              id: c.id,
              name: c.name,
              type: CHANNEL_TYPE_LABELS[c.type] ?? `type ${c.type}`,
            })),
        }));
      const uncategorized = channels
        .filter((c) => c.type !== 4 && !c.parent_id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: CHANNEL_TYPE_LABELS[c.type] ?? `type ${c.type}`,
        }));

      const members = guildData.approximate_member_count ?? 0;
      const online = guildData.approximate_presence_count ?? 0;

      return ok(
        `${guildData.name}: ${members} members (${online} online), ` +
          `${channels.length} channels in ${categories.length} categories, ` +
          `${guildData.roles.length} roles, boost tier ${guildData.premium_tier}.`,
        {
          id: guildData.id,
          name: guildData.name,
          description: guildData.description,
          owner_id: guildData.owner_id,
          members: { approximate: members, online_approximate: online },
          boost: {
            tier: guildData.premium_tier,
            count: guildData.premium_subscription_count ?? 0,
          },
          channel_counts: byType,
          categories,
          uncategorized,
          role_count: guildData.roles.length,
          emoji_count: guildData.emojis.length,
          features: guildData.features.slice(0, 10),
        }
      );
    })
  );

  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description:
        "All channels in a server grouped by category, with type and topic. " +
        "Filter by type: text, voice, forum, stage, announcement, category.",
      inputSchema: {
        guild: guildParam,
        type: z
          .enum(["text", "voice", "forum", "stage", "announcement", "category"])
          .optional()
          .describe("Only return channels of this type."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, type }) => {
      const { rest, guildId } = await enter(config, guild);
      const channels = await getChannels(rest, guildId);

      const typeFilter: Record<string, number[]> = {
        text: [0],
        voice: [2],
        forum: [15],
        stage: [13],
        announcement: [5],
        category: [4],
      };
      const wanted = type ? typeFilter[type] : undefined;
      const visible = channels.filter(
        (c) => !wanted || wanted.includes(c.type)
      );

      const catNames = new Map(
        channels.filter((c) => c.type === 4).map((c) => [c.id, c.name])
      );
      const listed = visible
        .filter((c) => c.type !== 4 || type === "category")
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: CHANNEL_TYPE_LABELS[c.type] ?? `type ${c.type}`,
          category: c.parent_id ? catNames.get(c.parent_id) ?? null : null,
          ...(c.topic ? { topic: c.topic } : {}),
        }));

      return ok(
        `${listed.length} channel(s)` +
          (type ? ` of type ${type}` : "") +
          ` in this server.`,
        { channels: listed }
      );
    })
  );

  server.registerTool(
    "list_roles",
    {
      title: "List roles",
      description:
        "All roles in a server, highest first, with color, position, and a " +
        "plain-language digest of their key permissions.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const roles = await getRoles(rest, guildId);
      const listed = [...roles]
        .sort((a, b) => b.position - a.position)
        .map((r) => ({
          id: r.id,
          name: r.name,
          position: r.position,
          color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null,
          hoisted: r.hoist,
          mentionable: r.mentionable,
          managed: r.managed,
          key_permissions: permissionDigest(r.permissions),
        }));
      return ok(`${listed.length} role(s), listed highest first.`, {
        roles: listed,
      });
    })
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read messages",
      description:
        "Recent messages from a channel as a digest: author, time, content, " +
        "attachments, reactions, and resolved reply references. Returns " +
        "oldest first. Use next_before to page further back.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        limit: z.number().int().min(1).max(100).optional()
          .describe("How many messages, 1 to 100. Default 25."),
        before: z.string().optional()
          .describe("Message ID cursor: only messages older than this."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild, limit, before }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );

      const query = new URLSearchParams({ limit: String(limit ?? 25) });
      if (before) query.set("before", before);
      const messages = (await rest.get(Routes.channelMessages(target.id), {
        query,
      })) as APIMessage[];

      // Discord returns newest first; oldest first reads naturally.
      const digests = messages.reverse().map(digestMessage);
      const oldest = digests[0]?.created_at;
      const newest = digests[digests.length - 1]?.created_at;

      return ok(
        digests.length === 0
          ? `#${target.name} has no messages in this range.`
          : `Read ${digests.length} message(s) from #${target.name}` +
              ` spanning ${oldest} to ${newest}.`,
        {
          channel: { id: target.id, name: target.name },
          messages: digests,
          // Pass this as before to page further back in time.
          next_before: digests[0]?.id ?? null,
        }
      );
    })
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Search recent messages in one channel by content and author. The " +
        "bot API has no native search, so this scans history newest to " +
        "oldest up to scan_limit messages and reports exactly how far it " +
        "looked. Results are case-insensitive substring matches.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID to search in."),
        guild: guildParam,
        query: z.string().min(1).describe("Text to look for."),
        author: z.string().optional()
          .describe("Only messages whose author name matches this."),
        limit: z.number().int().min(1).max(50).optional()
          .describe("Max results. Default 10."),
        scan_limit: z.number().int().min(50).max(1000).optional()
          .describe("How many messages to scan before stopping. Default 300."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild, query, author, limit, scan_limit }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(
        rest,
        guildId,
        channel,
        TEXT_BEARING_TYPES
      );

      const wanted = limit ?? 10;
      const maxScan = scan_limit ?? 300;
      const needle = query.toLowerCase();
      const authorNeedle = author?.toLowerCase();

      const hits: ReturnType<typeof digestMessage>[] = [];
      let scanned = 0;
      let cursor: string | undefined;
      let oldestSeen: string | undefined;

      while (scanned < maxScan && hits.length < wanted) {
        const page = new URLSearchParams({
          limit: String(Math.min(100, maxScan - scanned)),
        });
        if (cursor) page.set("before", cursor);
        const batch = (await rest.get(Routes.channelMessages(target.id), {
          query: page,
        })) as APIMessage[];
        if (batch.length === 0) break;

        for (const m of batch) {
          scanned += 1;
          oldestSeen = m.timestamp;
          const contentHit = (m.content ?? "").toLowerCase().includes(needle);
          const authorHit =
            !authorNeedle ||
            m.author.username.toLowerCase().includes(authorNeedle) ||
            (m.author.global_name ?? "").toLowerCase().includes(authorNeedle);
          if (contentHit && authorHit) {
            hits.push(digestMessage(m));
            if (hits.length >= wanted) break;
          }
        }
        cursor = batch[batch.length - 1]?.id;
        if (batch.length < 100) break;
      }

      return ok(
        `Found ${hits.length} match(es) for "${query}" in #${target.name}. ` +
          `Scanned ${scanned} message(s)` +
          (oldestSeen ? `, back to ${oldestSeen}.` : "."),
        {
          channel: { id: target.id, name: target.name },
          matches: hits,
          scanned: { count: scanned, oldest_reached: oldestSeen ?? null },
        },
        scanned >= maxScan
          ? [
              "Scan limit reached. Older messages were not searched; raise " +
                "scan_limit to look further back.",
            ]
          : []
      );
    })
  );

  server.registerTool(
    "search_members",
    {
      title: "Search members",
      description:
        "Find specific members by a name fragment, or list those holding a " +
        "given role. For the whole roster use list_members; for one " +
        "member's full profile use get_member; to turn a fuzzy name into an " +
        "id use find. Name search uses Discord's member search; role " +
        "filtering walks the member list and reports if it hit the paging cap.",
      inputSchema: {
        guild: guildParam,
        query: z.string().optional()
          .describe("Name prefix to search for (username or nickname)."),
        role: z.string().optional()
          .describe("Role name or ID; returns members holding it."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max results. Default 25."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, query, role, limit }) => {
      const { rest, guildId } = await enter(config, guild);
      const max = limit ?? 25;

      if (!query && !role) {
        return fail("Provide query (name prefix) or role (role name or ID).");
      }

      let members: APIGuildMember[] = [];
      const warnings: string[] = [];

      if (query) {
        members = (await rest.get(Routes.guildMembersSearch(guildId), {
          query: new URLSearchParams({ query, limit: String(max) }),
        })) as RESTGetAPIGuildMembersSearchResult;
      } else if (role) {
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
        // Walk the member list. Capped at 3 pages (3000 members) to stay
        // polite; the warning says so when the cap bites.
        let after: string | undefined;
        for (let page = 0; page < 3; page += 1) {
          const params = new URLSearchParams({ limit: "1000" });
          if (after) params.set("after", after);
          const batch = (await rest.get(Routes.guildMembers(guildId), {
            query: params,
          })) as APIGuildMember[];
          for (const m of batch) {
            if (m.roles.includes(resolution.match.id)) members.push(m);
          }
          if (batch.length < 1000) {
            after = undefined;
            break;
          }
          after = batch[batch.length - 1]?.user?.id;
        }
        if (after) {
          warnings.push(
            "Stopped after scanning 3000 members; larger servers need " +
              "paging support that lands in a later phase."
          );
        }
        members = members.slice(0, max);
      }

      const listed = members.map((m) => ({
        id: m.user?.id,
        name: m.user?.username,
        display_name: memberDisplayName(m),
        bot: m.user?.bot ?? false,
        joined_at: m.joined_at,
        role_count: m.roles.length,
      }));

      return ok(
        `Found ${listed.length} member(s)` +
          (query ? ` matching "${query}"` : "") +
          (role ? ` holding role "${role}"` : "") +
          ".",
        { members: listed },
        warnings
      );
    })
  );

  server.registerTool(
    "get_member",
    {
      title: "Get member",
      description:
        "One member in detail: identity, nickname, roles by name, join " +
        "date, and timeout state. Accepts a user ID or a name.",
      inputSchema: {
        user: z.string().describe("Member name or user ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ user, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const member = await resolveMember(rest, guildId, user);
      if (!member.user) return fail(`Could not load member "${user}".`);

      const roles = await getRoles(rest, guildId);
      const roleNames = member.roles
        .map((id) => roles.find((r) => r.id === id)?.name)
        .filter((n): n is string => Boolean(n));

      const timedOut =
        member.communication_disabled_until &&
        new Date(member.communication_disabled_until) > new Date();

      return ok(
        `${memberDisplayName(member)} (${member.user.username}): ` +
          `${roleNames.length} role(s), joined ${member.joined_at}` +
          (timedOut ? ", currently timed out." : "."),
        {
          id: member.user.id,
          username: member.user.username,
          display_name: memberDisplayName(member),
          nickname: member.nick ?? null,
          bot: member.user.bot ?? false,
          joined_at: member.joined_at,
          roles: roleNames,
          timed_out_until: timedOut
            ? member.communication_disabled_until
            : null,
          pending_onboarding: member.pending ?? false,
        }
      );
    })
  );

  server.registerTool(
    "find",
    {
      title: "Find anything",
      description:
        "Universal name resolver. Give it a name fragment and get ranked " +
        "candidates across channels, roles, and members with their IDs. Use " +
        "this when unsure what an entity is called or to grab an ID once " +
        "and reuse it.",
      inputSchema: {
        query: z.string().min(1).describe("Name or fragment to look up."),
        guild: guildParam,
        types: z
          .array(z.enum(["channel", "role", "member"]))
          .optional()
          .describe("Restrict the search. Default: all three."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ query, guild, types }) => {
      const { rest, guildId } = await enter(config, guild);
      const wanted = new Set(types ?? ["channel", "role", "member"]);
      const pool: Resolvable[] = [];

      if (wanted.has("channel")) {
        const channels = await getChannels(rest, guildId);
        const catNames = new Map(
          channels.filter((c) => c.type === 4).map((c) => [c.id, c.name])
        );
        for (const c of channels) {
          pool.push({
            id: c.id,
            name: c.name ?? "",
            type: `${CHANNEL_TYPE_LABELS[c.type] ?? "channel"} channel`,
            context: c.parent_id
              ? `in ${catNames.get(c.parent_id) ?? "a category"}`
              : undefined,
          });
        }
      }
      if (wanted.has("role")) {
        const roles = await getRoles(rest, guildId);
        for (const r of roles) {
          pool.push({ id: r.id, name: r.name, type: "role" });
        }
      }
      if (wanted.has("member") && !/^\d{17,20}$/.test(query.trim())) {
        const found = (await rest.get(Routes.guildMembersSearch(guildId), {
          query: new URLSearchParams({ query, limit: "10" }),
        })) as RESTGetAPIGuildMembersSearchResult;
        for (const m of found) {
          if (!m.user) continue;
          pool.push({
            id: m.user.id,
            name: m.user.username,
            type: "member",
            context: memberDisplayName(m),
          });
        }
      }

      const resolution = resolveOne(query, pool);
      if ("match" in resolution) {
        return ok(
          `"${query}" resolves to ${resolution.match.type} ` +
            `${resolution.match.name} (${resolution.match.id}).`,
          { match: resolution.match }
        );
      }
      if (resolution.candidates.length === 0) {
        return ok(`Nothing matches "${query}" in this server.`, {
          candidates: [],
        });
      }
      return ok(
        `${resolution.candidates.length} candidate(s) for "${query}". ` +
          "Pick one by ID.",
        { candidates: resolution.candidates }
      );
    })
  );
}
