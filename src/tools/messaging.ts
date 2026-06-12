import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type { APIMessage, APIChannel } from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { gateDestructive } from "../safety.js";
import {
  saveSchedule,
  listSchedules,
  cancelSchedule,
  type Repeat,
} from "../scheduler.js";
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
  botPermissions,
  requirePermissions,
} from "./common.js";

// Direct messages, single-message reads, bulk deletion, crossposting, and
// the message scheduler.

const P = PermissionFlagsBits;

export function registerMessagingTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "get_message",
    {
      title: "Get message",
      description:
        "Fetch one message in full: author, content, timestamps, " +
        "attachments, embeds, reactions, and any reply reference.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild, message_id }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      return ok(
        `Message by ${message.author.global_name ?? message.author.username} ` +
          `in #${target.name}.`,
        { channel: { id: target.id, name: target.name }, message: digestMessage(message) }
      );
    })
  );

  server.registerTool(
    "send_dm",
    {
      title: "Send direct message",
      description:
        "Send a direct message from the bot to a member who shares a " +
        "server with it. Fails gracefully when the recipient has DMs " +
        "closed. The message comes from the bot, never from a user account.",
      inputSchema: {
        user: z.string().describe("Member name or user ID."),
        guild: guildParam,
        content: z.string().min(1).max(2000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ user, guild, content }) => {
      const { rest, guildId } = await enter(config, guild);
      const member = await resolveMember(rest, guildId, user);
      if (!member.user) return fail(`Could not load member "${user}".`);

      const dm = (await rest.post(Routes.userChannels(), {
        body: { recipient_id: member.user.id },
      })) as APIChannel;

      try {
        await rest.post(Routes.channelMessages(dm.id), {
          body: { content, allowed_mentions: { parse: [] } },
        });
      } catch (err) {
        if ((err as { status?: number }).status === 403) {
          return fail(
            `${memberDisplayName(member)} has direct messages closed to this ` +
              "server, so the message could not be delivered."
          );
        }
        throw err;
      }

      return ok(`Sent a direct message to ${memberDisplayName(member)}.`, {
        recipient: { id: member.user.id, name: memberDisplayName(member) },
      });
    })
  );

  server.registerTool(
    "bulk_delete_messages",
    {
      title: "Bulk delete messages",
      description:
        "Delete many recent messages at once (2 to 100), optionally " +
        "filtered by author or text. Discord cannot bulk delete messages " +
        "older than 14 days. Safe to call directly: the first call returns " +
        "the exact list it would remove plus a confirm_token; repeating " +
        "the call with the token deletes them.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        count: z.number().int().min(1).max(100).optional()
          .describe("How many recent messages to scan. Default 50."),
        from_author: z.string().optional()
          .describe("Only delete messages whose author name matches this."),
        contains: z.string().optional()
          .describe("Only delete messages containing this text."),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ channel, guild, count, from_author, contains, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.ManageMessages, "Manage Messages"]],
        `in #${target.name}`
      );

      const recent = (await rest.get(Routes.channelMessages(target.id), {
        query: new URLSearchParams({ limit: String(count ?? 50) }),
      })) as APIMessage[];

      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const authorNeedle = from_author?.toLowerCase();
      const textNeedle = contains?.toLowerCase();
      const eligible = recent.filter((m) => {
        if (new Date(m.timestamp).getTime() < cutoff) return false;
        if (
          authorNeedle &&
          !m.author.username.toLowerCase().includes(authorNeedle) &&
          !(m.author.global_name ?? "").toLowerCase().includes(authorNeedle)
        ) {
          return false;
        }
        if (textNeedle && !(m.content ?? "").toLowerCase().includes(textNeedle)) {
          return false;
        }
        return true;
      });

      if (eligible.length === 0) {
        return ok(
          "No messages in range match those filters (Discord cannot bulk " +
            "delete messages older than 14 days).",
          { deleted: 0 }
        );
      }

      const ids = eligible.map((m) => m.id);
      const gate = gateDestructive({
        tool: "bulk_delete_messages",
        args: { channel: target.id, ids: ids.join(",") },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete ${ids.length} message(s) in #${target.name}` +
          (from_author ? ` from ${from_author}` : "") +
          (contains ? ` containing "${contains}"` : "") +
          ". This cannot be undone.",
        previewDetails: {
          count: ids.length,
          sample: eligible.slice(0, 5).map((m) => ({
            author: m.author.username,
            excerpt: (m.content ?? "").slice(0, 60),
          })),
        },
      });
      if (gate) return gate;

      if (ids.length === 1) {
        await rest.delete(Routes.channelMessage(target.id, ids[0]));
      } else {
        await rest.post(Routes.channelBulkDelete(target.id), {
          body: { messages: ids },
          reason: "Bulk delete via Omnicord",
        });
      }
      return ok(`Deleted ${ids.length} message(s) in #${target.name}.`, {
        deleted: ids.length,
      });
    })
  );

  server.registerTool(
    "crosspost_message",
    {
      title: "Crosspost message",
      description:
        "Publish a message in an announcement channel out to every server " +
        "that follows it.",
      inputSchema: {
        channel: z.string().describe("Announcement channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, [5]);
      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.SendMessages, "Send Messages"]],
        `in #${target.name}`
      );
      await rest.post(Routes.channelMessageCrosspost(target.id, message_id));
      return ok(`Published the message from #${target.name} to followers.`, {
        message_id,
      });
    })
  );

  server.registerTool(
    "schedule_message",
    {
      title: "Schedule message",
      description:
        "Post a text message to a channel at a later time, once or on a " +
        "daily or weekly repeat. This sends an ordinary message; for a " +
        "community event members can RSVP to, use create_event. Omnicord " +
        "sends it when the time comes. One limit worth " +
        "knowing: delivery needs the Omnicord process to be running at " +
        "that moment, so always-on scheduling wants the hosted or Docker " +
        "deployment rather than a laptop that sleeps. A message that came " +
        "due during downtime is sent at the next start.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        content: z.string().min(1).max(2000),
        send_at: z.string()
          .describe("When to send, ISO time like 2026-07-01T17:00:00Z."),
        repeat: z.enum(["none", "daily", "weekly"]).optional()
          .describe("Default none."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, content, send_at, repeat }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(perms, [[P.SendMessages, "Send Messages"]], `in #${target.name}`);

      const when = new Date(send_at);
      if (Number.isNaN(when.getTime())) {
        return fail(`Could not parse send_at "${send_at}". Use ISO time.`);
      }
      if ((repeat ?? "none") === "none" && when.getTime() <= Date.now()) {
        return fail("send_at is in the past. Pick a future time.");
      }

      const schedule = saveSchedule({
        guildId,
        channelId: target.id,
        channelName: target.name ?? target.id,
        content,
        sendAt: when,
        repeat: (repeat ?? "none") as Repeat,
      });

      return ok(
        `Scheduled a message to #${target.name} for ${schedule.send_at}` +
          (schedule.repeat !== "none" ? `, repeating ${schedule.repeat}` : "") +
          `. Schedule id ${schedule.id}.`,
        {
          id: schedule.id,
          channel: { id: target.id, name: target.name },
          send_at: schedule.send_at,
          repeat: schedule.repeat,
        }
      );
    })
  );

  server.registerTool(
    "list_scheduled_messages",
    {
      title: "List scheduled messages",
      description:
        "Pending timed messages waiting to send, soonest first. These are " +
        "messages queued with schedule_message, not Discord community " +
        "events (list_events).",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { guildId } = await enter(config, guild);
      const all = listSchedules().filter((s) => s.guild_id === guildId);
      return ok(`${all.length} scheduled message(s).`, {
        scheduled: all.map((s) => ({
          id: s.id,
          channel: s.channel_name,
          send_at: s.send_at,
          repeat: s.repeat,
          preview: s.content.slice(0, 80),
        })),
      });
    })
  );

  server.registerTool(
    "cancel_scheduled_message",
    {
      title: "Cancel scheduled message",
      description: "Cancel a pending scheduled message by its id.",
      inputSchema: {
        schedule_id: z.string(),
        guild: guildParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ schedule_id }) => {
      const removed = cancelSchedule(schedule_id.trim());
      if (!removed) return fail(`No scheduled message ${schedule_id}.`);
      return ok(`Canceled scheduled message ${schedule_id}.`, { canceled: true });
    })
  );
}
