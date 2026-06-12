import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIThreadChannel,
  APIThreadMember,
  RESTGetAPIGuildThreadsResult,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getChannels } from "../discord/guildData.js";
import { resolveOne } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  resolveMember,
  memberDisplayName,
  ToolProblem,
  THREAD_TYPES,
  botPermissions,
  requirePermissions,
} from "./common.js";

// Threads: create, browse, manage state, and manage membership.

const P = PermissionFlagsBits;

const AUTO_ARCHIVE = [60, 1440, 4320, 10080] as const;

function threadDigest(t: APIThreadChannel) {
  return {
    id: t.id,
    name: t.name,
    parent_id: t.parent_id ?? null,
    archived: t.thread_metadata?.archived ?? false,
    locked: t.thread_metadata?.locked ?? false,
    private: t.type === 12,
    message_count: t.message_count ?? 0,
    member_count: t.member_count ?? 0,
  };
}

async function activeThreads(
  rest: REST,
  guildId: string
): Promise<APIThreadChannel[]> {
  const result = (await rest.get(
    Routes.guildActiveThreads(guildId)
  )) as RESTGetAPIGuildThreadsResult;
  return (result.threads ?? []) as APIThreadChannel[];
}

// Threads resolve against the active thread list first, then fall back
// to a direct ID lookup through resolveChannel's thread fallback.
export async function resolveThread(
  rest: REST,
  guildId: string,
  query: string
): Promise<APIThreadChannel> {
  const threads = await activeThreads(rest, guildId);
  const resolution = resolveOne(
    query,
    threads.map((t) => ({ id: t.id, name: t.name ?? "", type: "thread" }))
  );
  if ("match" in resolution) {
    const found = threads.find((t) => t.id === resolution.match.id);
    if (found) return found;
  }
  if (/^\d{17,20}$/.test(query.trim())) {
    const direct = await resolveChannel(rest, guildId, query, THREAD_TYPES);
    return direct as unknown as APIThreadChannel;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(
          `No active thread matching "${query}". Archived threads need ` +
            "their ID; find them with list_threads include_archived."
        )
      : fail(`Multiple threads match "${query}". Pick one by ID.`, { candidates })
  );
}

export function registerThreadTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "create_thread",
    {
      title: "Create thread",
      description:
        "Start a thread in a text or announcement channel: standalone, " +
        "branched from a message when message_id is given, or private " +
        "(invite-only) when asked. For a post in a forum channel, use " +
        "create_forum_post instead.",
      inputSchema: {
        channel: z.string().describe("Parent channel name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100),
        message_id: z.string().optional()
          .describe("Branch the thread from this message."),
        private: z.boolean().optional()
          .describe("Invite-only thread; only works standalone."),
        auto_archive_minutes: z
          .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
          .optional()
          .describe("Inactivity timeout: 60, 1440, 4320, or 10080. Default 1440."),
        slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      channel,
      guild,
      name,
      message_id,
      private: isPrivate,
      auto_archive_minutes,
      slowmode_seconds,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, [0, 5]);

      if (isPrivate && message_id) {
        return fail("A thread branched from a message is always public.");
      }

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [
          isPrivate
            ? [P.CreatePrivateThreads, "Create Private Threads"]
            : [P.CreatePublicThreads, "Create Public Threads"],
        ],
        `in #${target.name}`
      );

      const body: Record<string, unknown> = {
        name,
        auto_archive_duration: auto_archive_minutes ?? 1440,
        ...(slowmode_seconds !== undefined
          ? { rate_limit_per_user: slowmode_seconds }
          : {}),
      };
      if (!message_id) {
        body.type = isPrivate ? 12 : 11;
      }

      let thread: APIThreadChannel;
      try {
        thread = (await rest.post(Routes.threads(target.id, message_id), {
          body,
          reason: "Created via Omnicord",
        })) as APIThreadChannel;
      } catch (err) {
        // 50068: system notices like join messages cannot host threads.
        if (
          err instanceof Error &&
          "code" in err &&
          (err as { code?: unknown }).code === 50068
        ) {
          return fail(
            "That message is a system notice (like a join message), and " +
              "Discord cannot attach threads to those. Pick a regular " +
              "message, or create the thread without a message_id."
          );
        }
        throw err;
      }

      return ok(
        `Created ${isPrivate ? "private " : ""}thread ${thread.name} ` +
          `under #${target.name}` +
          (message_id ? " from the message" : "") +
          ".",
        threadDigest(thread)
      );
    })
  );

  server.registerTool(
    "list_threads",
    {
      title: "List threads",
      description:
        "Active threads across the server or one channel. Archived " +
        "threads come from a specific channel with include_archived.",
      inputSchema: {
        guild: guildParam,
        channel: z.string().optional()
          .describe("Limit to threads under this channel."),
        include_archived: z.boolean().optional()
          .describe("Also list archived threads; needs channel."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, channel, include_archived }) => {
      const { rest, guildId } = await enter(config, guild);

      let parentId: string | undefined;
      let parentName: string | undefined;
      if (channel) {
        const target = await resolveChannel(rest, guildId, channel);
        parentId = target.id;
        parentName = target.name ?? undefined;
      }
      if (include_archived && !parentId) {
        return fail("include_archived needs a channel to look under.");
      }

      const active = (await activeThreads(rest, guildId)).filter(
        (t) => !parentId || t.parent_id === parentId
      );
      let archived: APIThreadChannel[] = [];
      if (include_archived && parentId) {
        const result = (await rest.get(
          Routes.channelThreads(parentId, "public")
        )) as { threads: APIThreadChannel[] };
        archived = result.threads ?? [];
      }

      return ok(
        `${active.length} active thread(s)` +
          (include_archived ? `, ${archived.length} archived` : "") +
          (parentName ? ` under #${parentName}` : "") +
          ".",
        {
          active: active.map(threadDigest),
          ...(include_archived ? { archived: archived.map(threadDigest) } : {}),
        }
      );
    })
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get thread",
      description: "One thread's settings, state, and counts.",
      inputSchema: {
        thread: z.string().describe("Thread name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ thread, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveThread(rest, guildId, thread);
      return ok(
        `Thread ${found.name}: ` +
          `${found.thread_metadata?.archived ? "archived" : "active"}, ` +
          `${found.message_count ?? 0} message(s).`,
        threadDigest(found)
      );
    })
  );

  server.registerTool(
    "update_thread",
    {
      title: "Update thread",
      description:
        "Rename a thread, archive or unarchive it, lock or unlock it, or " +
        "change its slowmode and auto-archive window.",
      inputSchema: {
        thread: z.string().describe("Thread name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100).optional(),
        archived: z.boolean().optional(),
        locked: z.boolean().optional(),
        slowmode_seconds: z.number().int().min(0).max(21600).optional(),
        auto_archive_minutes: z
          .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      thread,
      guild,
      name,
      archived,
      locked,
      slowmode_seconds,
      auto_archive_minutes,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveThread(rest, guildId, thread);

      const changes: string[] = [];
      if (name !== undefined) changes.push(`name to "${name}"`);
      if (archived !== undefined) changes.push(archived ? "archived" : "unarchived");
      if (locked !== undefined) changes.push(locked ? "locked" : "unlocked");
      if (slowmode_seconds !== undefined) changes.push(`slowmode ${slowmode_seconds}s`);
      if (auto_archive_minutes !== undefined)
        changes.push(`auto-archive ${auto_archive_minutes}m`);
      if (changes.length === 0) return fail("Pass at least one field to change.");

      await rest.patch(Routes.channel(found.id), {
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(archived !== undefined ? { archived } : {}),
          ...(locked !== undefined ? { locked } : {}),
          ...(slowmode_seconds !== undefined
            ? { rate_limit_per_user: slowmode_seconds }
            : {}),
          ...(auto_archive_minutes !== undefined
            ? { auto_archive_duration: auto_archive_minutes }
            : {}),
        },
        reason: "Updated via Omnicord",
      });
      return ok(`Updated thread ${found.name}: ${changes.join(", ")}.`, {
        id: found.id,
        changed: changes,
      });
    })
  );

  server.registerTool(
    "delete_thread",
    {
      title: "Delete thread",
      description:
        "Delete a thread and its messages. Safe to call directly: the " +
        "first call changes nothing and returns a preview plus a " +
        "confirm_token; repeating the call with the token deletes it. " +
        "Archiving is the reversible alternative.",
      inputSchema: {
        thread: z.string().describe("Thread name or ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ thread, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveThread(rest, guildId, thread);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageThreads, "Manage Threads"]], "in this server");

      const gate = gateDestructive({
        tool: "delete_thread",
        args: { thread: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the thread ${found.name} and its ` +
          `${found.message_count ?? 0} message(s) forever. Archiving it ` +
          "instead keeps the history.",
        previewDetails: threadDigest(found),
      });
      if (gate) return gate;

      await rest.delete(Routes.channel(found.id), {
        reason: reason ?? "Deleted via Omnicord",
      });
      return ok(`Deleted the thread ${found.name}.`, {
        deleted: true,
        id: found.id,
      });
    })
  );

  server.registerTool(
    "list_thread_members",
    {
      title: "List thread members",
      description: "Who is in a thread.",
      inputSchema: {
        thread: z.string().describe("Thread name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ thread, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveThread(rest, guildId, thread);
      const members = (await rest.get(Routes.threadMembers(found.id), {
        query: new URLSearchParams({ with_member: "true" }),
      })) as Array<APIThreadMember & { member?: { nick?: string | null; user?: { id: string; username: string; global_name?: string | null } } }>;

      return ok(`${members.length} member(s) in ${found.name}.`, {
        thread: { id: found.id, name: found.name },
        members: members.map((m) => ({
          id: m.user_id,
          name:
            m.member?.nick ??
            m.member?.user?.global_name ??
            m.member?.user?.username ??
            null,
        })),
      });
    })
  );

  server.registerTool(
    "add_thread_member",
    {
      title: "Add thread member",
      description: "Pull a member into a thread.",
      inputSchema: {
        thread: z.string().describe("Thread name or ID."),
        guild: guildParam,
        member: z.string().describe("Member name or user ID."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ thread, guild, member }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveThread(rest, guildId, thread);
      const target = await resolveMember(rest, guildId, member);
      if (!target.user) return fail(`Could not load member "${member}".`);

      await rest.put(Routes.threadMembers(found.id, target.user.id));
      return ok(`Added ${memberDisplayName(target)} to ${found.name}.`, {
        thread: { id: found.id, name: found.name },
        member: { id: target.user.id, name: memberDisplayName(target) },
      });
    })
  );

  server.registerTool(
    "remove_thread_member",
    {
      title: "Remove thread member",
      description: "Remove a member from a thread. Needs Manage Threads.",
      inputSchema: {
        thread: z.string().describe("Thread name or ID."),
        guild: guildParam,
        member: z.string().describe("Member name or user ID."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ thread, guild, member }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveThread(rest, guildId, thread);
      const target = await resolveMember(rest, guildId, member);
      if (!target.user) return fail(`Could not load member "${member}".`);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageThreads, "Manage Threads"]], "in this server");

      await rest.delete(Routes.threadMembers(found.id, target.user.id));
      return ok(`Removed ${memberDisplayName(target)} from ${found.name}.`, {
        removed: true,
      });
    })
  );
}
