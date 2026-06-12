import { z } from "zod";
import { Routes, PermissionFlagsBits, ChannelFlags } from "discord-api-types/v10";
import type {
  APIThreadChannel,
  RESTGetAPIGuildThreadsResult,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { invalidateGuildCaches, type GuildChannelLite } from "../discord/guildData.js";
import { resolveOne } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  ToolProblem,
  botPermissions,
  requirePermissions,
  embedsParam,
  mapEmbeds,
} from "./common.js";

// Forum channels: posts are threads underneath, tags live on the channel.

const P = PermissionFlagsBits;

interface ForumTag {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

interface ForumChannel extends GuildChannelLite {
  available_tags?: ForumTag[];
}

async function resolveForum(
  rest: REST,
  guildId: string,
  query: string
): Promise<ForumChannel> {
  return (await resolveChannel(rest, guildId, query, [15])) as ForumChannel;
}

function resolveTagByName(
  forum: ForumChannel,
  name: string
): ForumTag {
  const tags = forum.available_tags ?? [];
  const resolution = resolveOne(
    name,
    tags
      .filter((t) => t.id)
      .map((t) => ({ id: t.id as string, name: t.name, type: "tag" }))
  );
  if ("match" in resolution) {
    const tag = tags.find((t) => t.id === resolution.match.id);
    if (tag) return tag;
  }
  throw new ToolProblem(
    fail(`No single tag matching "${name}" on this forum.`, {
      available: tags.map((t) => t.name),
    })
  );
}

function postDigest(t: APIThreadChannel, forum?: ForumChannel) {
  const tagNames = new Map(
    (forum?.available_tags ?? []).map((tag) => [tag.id, tag.name])
  );
  return {
    id: t.id,
    title: t.name,
    archived: t.thread_metadata?.archived ?? false,
    locked: t.thread_metadata?.locked ?? false,
    pinned: ((t.flags ?? 0) & ChannelFlags.Pinned) !== 0,
    message_count: t.message_count ?? 0,
    tags: (t.applied_tags ?? []).map((id) => tagNames.get(id) ?? id),
  };
}

export function registerForumTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "create_forum_post",
    {
      title: "Create forum post",
      description:
        "Start a post in a forum channel: a title, the opening message, " +
        "and optional tags from the forum's tag list.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        title: z.string().min(1).max(100),
        content: z.string().min(1).max(2000),
        tags: z.array(z.string()).max(5).optional()
          .describe("Tag names to apply."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ forum, guild, title, content, tags }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveForum(rest, guildId, forum);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.SendMessages, "Send Messages"]], `in ${target.name}`);

      const appliedTags = (tags ?? []).map(
        (name) => resolveTagByName(target, name).id as string
      );

      const post = (await rest.post(Routes.threads(target.id), {
        body: {
          name: title,
          // Mentions suppressed: a model echoing user text into a new
          // forum post must not be able to mass-ping by accident.
          message: { content, allowed_mentions: { parse: [] } },
          ...(appliedTags.length > 0 ? { applied_tags: appliedTags } : {}),
        },
        reason: "Created via Omnicord",
      })) as APIThreadChannel;

      return ok(
        `Posted "${title}" in ${target.name}` +
          (tags?.length ? ` tagged ${tags.join(", ")}` : "") +
          ".",
        postDigest(post, target)
      );
    })
  );

  server.registerTool(
    "list_forum_posts",
    {
      title: "List forum posts",
      description: "Posts in a forum, filterable by tag, optionally archived too.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        tag: z.string().optional().describe("Only posts carrying this tag."),
        include_archived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ forum, guild, tag, include_archived }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveForum(rest, guildId, forum);

      const tagId = tag ? resolveTagByName(target, tag).id : undefined;

      const activeResult = (await rest.get(
        Routes.guildActiveThreads(guildId)
      )) as RESTGetAPIGuildThreadsResult;
      let posts = ((activeResult.threads ?? []) as APIThreadChannel[]).filter(
        (t) => t.parent_id === target.id
      );
      if (include_archived) {
        const archived = (await rest.get(
          Routes.channelThreads(target.id, "public")
        )) as { threads: APIThreadChannel[] };
        posts = posts.concat(archived.threads ?? []);
      }
      if (tagId) {
        posts = posts.filter((t) => (t.applied_tags ?? []).includes(tagId));
      }

      return ok(
        `${posts.length} post(s) in ${target.name}` +
          (tag ? ` tagged ${tag}` : "") +
          ".",
        { posts: posts.map((p) => postDigest(p, target)) }
      );
    })
  );

  server.registerTool(
    "reply_to_forum_post",
    {
      title: "Reply to forum post",
      description: "Add a reply inside a forum post.",
      inputSchema: {
        post: z.string().describe("Post title or thread ID."),
        guild: guildParam,
        content: z.string().min(1).max(2000),
        embeds: embedsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ post, guild, content, embeds }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await findPost(rest, guildId, post);

      const sent = (await rest.post(Routes.channelMessages(found.id), {
        body: {
          content,
          allowed_mentions: { parse: [] },
          ...(embeds && embeds.length > 0 ? { embeds: mapEmbeds(embeds) } : {}),
        },
      })) as { id: string };

      return ok(`Replied in "${found.name}".`, {
        id: sent.id,
        post: { id: found.id, title: found.name },
      });
    })
  );

  server.registerTool(
    "update_forum_post",
    {
      title: "Update forum post",
      description:
        "Edit a post's title or tags, pin or unpin it within the forum, " +
        "lock or unlock replies, or archive it.",
      inputSchema: {
        post: z.string().describe("Post title or thread ID."),
        guild: guildParam,
        title: z.string().min(1).max(100).optional(),
        tags: z.array(z.string()).max(5).optional()
          .describe("Replace the applied tags with these."),
        pinned: z.boolean().optional(),
        locked: z.boolean().optional(),
        archived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ post, guild, title, tags, pinned, locked, archived }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await findPost(rest, guildId, post);

      const changes: string[] = [];
      const body: Record<string, unknown> = {};
      if (title !== undefined) {
        body.name = title;
        changes.push(`title to "${title}"`);
      }
      if (tags !== undefined) {
        const forum = found.parent_id
          ? await resolveForum(rest, guildId, found.parent_id)
          : undefined;
        if (!forum) return fail("Could not load the parent forum for tags.");
        body.applied_tags = tags.map((n) => resolveTagByName(forum, n).id);
        changes.push(`tags to ${tags.join(", ") || "none"}`);
      }
      if (pinned !== undefined) {
        const current = (found.flags ?? 0) & ~ChannelFlags.Pinned;
        body.flags = pinned ? current | ChannelFlags.Pinned : current;
        changes.push(pinned ? "pinned" : "unpinned");
      }
      if (locked !== undefined) {
        body.locked = locked;
        changes.push(locked ? "locked" : "unlocked");
      }
      if (archived !== undefined) {
        body.archived = archived;
        changes.push(archived ? "archived" : "unarchived");
      }
      if (changes.length === 0) return fail("Pass at least one field to change.");

      await rest.patch(Routes.channel(found.id), {
        body,
        reason: "Updated via Omnicord",
      });
      return ok(`Updated "${found.name}": ${changes.join(", ")}.`, {
        id: found.id,
        changed: changes,
      });
    })
  );

  server.registerTool(
    "delete_forum_post",
    {
      title: "Delete forum post",
      description:
        "Delete a forum post and every reply in it. Safe to call " +
        "directly: the first call changes nothing and returns a preview " +
        "plus a confirm_token; repeating the call with the token deletes it.",
      inputSchema: {
        post: z.string().describe("Post title or thread ID."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ post, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await findPost(rest, guildId, post);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageThreads, "Manage Threads"]], "in this server");

      const gate = gateDestructive({
        tool: "delete_forum_post",
        args: { post: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the post "${found.name}" and its ` +
          `${found.message_count ?? 0} message(s) forever.`,
        previewDetails: { id: found.id, title: found.name },
      });
      if (gate) return gate;

      await rest.delete(Routes.channel(found.id), {
        reason: reason ?? "Deleted via Omnicord",
      });
      return ok(`Deleted the post "${found.name}".`, {
        deleted: true,
        id: found.id,
      });
    })
  );

  server.registerTool(
    "create_forum_tag",
    {
      title: "Create forum tag",
      description:
        "Add a tag to a forum's tag list. Moderated tags can only be " +
        "applied by people with Manage Threads.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(20),
        moderated: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ forum, guild, name, moderated }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveForum(rest, guildId, forum);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `for ${target.name}`);

      const existing = target.available_tags ?? [];
      if (existing.length >= 20) {
        return fail("Forums hold at most 20 tags.");
      }
      if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        return fail(`A tag named "${name}" already exists on this forum.`);
      }

      const updated = (await rest.patch(Routes.channel(target.id), {
        body: {
          available_tags: [
            ...existing,
            { name, moderated: moderated ?? false },
          ],
        },
        reason: "Tag added via Omnicord",
      })) as ForumChannel;
      invalidateGuildCaches(guildId);

      const created = (updated.available_tags ?? []).find(
        (t) => t.name === name
      );
      return ok(`Added the tag "${name}" to ${target.name}.`, {
        id: created?.id ?? null,
        name,
        moderated: moderated ?? false,
      });
    })
  );

  server.registerTool(
    "update_forum_tag",
    {
      title: "Update forum tag",
      description: "Rename a forum tag or change its moderated flag.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        tag: z.string().describe("Current tag name."),
        name: z.string().min(1).max(20).optional(),
        moderated: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ forum, guild, tag, name, moderated }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveForum(rest, guildId, forum);
      if (name === undefined && moderated === undefined) {
        return fail("Pass name or moderated to change.");
      }

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `for ${target.name}`);

      const current = resolveTagByName(target, tag);
      const updatedTags = (target.available_tags ?? []).map((t) =>
        t.id === current.id
          ? {
              ...t,
              ...(name !== undefined ? { name } : {}),
              ...(moderated !== undefined ? { moderated } : {}),
            }
          : t
      );

      await rest.patch(Routes.channel(target.id), {
        body: { available_tags: updatedTags },
        reason: "Tag updated via Omnicord",
      });
      invalidateGuildCaches(guildId);

      return ok(
        `Updated the tag "${current.name}"` +
          (name ? ` to "${name}"` : "") +
          ".",
        { id: current.id, name: name ?? current.name }
      );
    })
  );

  server.registerTool(
    "delete_forum_tag",
    {
      title: "Delete forum tag",
      description:
        "Remove a tag from a forum; posts carrying it simply lose it. " +
        "Safe to call directly: the first call changes nothing and " +
        "returns a preview plus a confirm_token; repeating the call with " +
        "the token removes it.",
      inputSchema: {
        forum: z.string().describe("Forum channel name or ID."),
        guild: guildParam,
        tag: z.string().describe("Tag name to remove."),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ forum, guild, tag, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveForum(rest, guildId, forum);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.ManageChannels, "Manage Channels"]], `for ${target.name}`);

      const current = resolveTagByName(target, tag);
      const gate = gateDestructive({
        tool: "delete_forum_tag",
        args: { forum: target.id, tag: current.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would remove the tag "${current.name}" from ${target.name}; ` +
          "posts carrying it lose it.",
        previewDetails: { id: current.id, name: current.name },
      });
      if (gate) return gate;

      await rest.patch(Routes.channel(target.id), {
        body: {
          available_tags: (target.available_tags ?? []).filter(
            (t) => t.id !== current.id
          ),
        },
        reason: "Tag removed via Omnicord",
      });
      invalidateGuildCaches(guildId);

      return ok(`Removed the tag "${current.name}" from ${target.name}.`, {
        deleted: true,
        id: current.id,
      });
    })
  );

  // Post resolution shared by the tools above: active threads whose
  // parent is a forum, by title or ID, with the direct-ID fallback.
  async function findPost(
    rest: REST,
    guildId: string,
    query: string
  ): Promise<APIThreadChannel> {
    const activeResult = (await rest.get(
      Routes.guildActiveThreads(guildId)
    )) as RESTGetAPIGuildThreadsResult;
    const posts = (activeResult.threads ?? []) as APIThreadChannel[];
    const resolution = resolveOne(
      query,
      posts.map((p) => ({ id: p.id, name: p.name ?? "", type: "post" }))
    );
    if ("match" in resolution) {
      const found = posts.find((p) => p.id === resolution.match.id);
      if (found) return found;
    }
    if (/^\d{17,20}$/.test(query.trim())) {
      const direct = await resolveChannel(rest, guildId, query, [10, 11, 12]);
      return direct as unknown as APIThreadChannel;
    }
    const candidates = "candidates" in resolution ? resolution.candidates : [];
    throw new ToolProblem(
      candidates.length === 0
        ? fail(`No active post matching "${query}".`)
        : fail(`Multiple posts match "${query}". Pick one by ID.`, { candidates })
    );
  }
}
