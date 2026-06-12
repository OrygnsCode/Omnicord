import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIEmoji,
  APIMessage,
  APIUser,
  RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { getBotUser } from "../discord/guildData.js";
import { resolveEmojiInput } from "../discord/emoji.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  resolveMember,
  ToolProblem,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
} from "./common.js";

// Reactions and polls.

const P = PermissionFlagsBits;

async function resolveEmoji(
  rest: REST,
  guildId: string,
  input: string
): Promise<{ api: string; display: string }> {
  const guildEmojis = (await rest.get(Routes.guildEmojis(guildId))) as APIEmoji[];
  const result = resolveEmojiInput(input, guildEmojis);
  if (!result.ok) {
    throw new ToolProblem(
      fail(result.reason, result.candidates ? { candidates: result.candidates } : {})
    );
  }
  return { api: result.api, display: result.display };
}

export function registerReactionTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "add_reactions",
    {
      title: "Add reactions",
      description:
        "Add one or more reactions to a message in a single call. Takes " +
        "unicode emoji directly or custom emoji by name.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
        emojis: z.array(z.string()).min(1).max(10)
          .describe("Emoji to add, like a pasted emoji or a custom emoji name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, emojis }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [
          [P.AddReactions, "Add Reactions"],
          [P.ReadMessageHistory, "Read Message History"],
        ],
        `in #${target.name}`
      );

      const added: string[] = [];
      for (const input of emojis) {
        const emoji = await resolveEmoji(rest, guildId, input);
        await rest.put(
          Routes.channelMessageOwnReaction(
            target.id,
            message_id,
            encodeURIComponent(emoji.api)
          )
        );
        added.push(emoji.display);
      }
      return ok(
        `Added ${added.length} reaction(s) to the message: ${added.join(" ")}.`,
        { added }
      );
    })
  );

  server.registerTool(
    "remove_reaction",
    {
      title: "Remove reaction",
      description:
        "Remove a reaction: the bot's own by default, or another user's " +
        "(which needs Manage Messages).",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
        emoji: z.string(),
        user: z.string().optional()
          .describe("Whose reaction to remove; omit for the bot's own."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id, emoji, user }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
      const resolved = await resolveEmoji(rest, guildId, emoji);
      const encoded = encodeURIComponent(resolved.api);

      if (user) {
        const member = await resolveMember(rest, guildId, user);
        if (!member.user) return fail(`Could not load member "${user}".`);
        const botUser = await getBotUser(rest);
        if (member.user.id !== botUser.id) {
          const perms = await botPermissions(rest, guildId, target);
          requirePermissions(
            perms,
            [[P.ManageMessages, "Manage Messages"]],
            `in #${target.name}`
          );
        }
        await rest.delete(
          Routes.channelMessageUserReaction(target.id, message_id, encoded, member.user.id)
        );
        return ok(`Removed ${resolved.display} reaction by ${member.user.username}.`, {
          removed: resolved.display,
          user: member.user.id,
        });
      }

      await rest.delete(
        Routes.channelMessageOwnReaction(target.id, message_id, encoded)
      );
      return ok(`Removed the bot's ${resolved.display} reaction.`, {
        removed: resolved.display,
      });
    })
  );

  server.registerTool(
    "clear_reactions",
    {
      title: "Clear reactions",
      description:
        "Clear all reactions from a message, or all of one emoji. Safe to " +
        "call directly: the first call changes nothing and returns a " +
        "preview plus a confirm_token; repeating the call with the token " +
        "executes. Relay the preview for the user's go-ahead.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
        emoji: z.string().optional()
          .describe("Only clear this emoji; omit to clear everything."),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ channel, guild, message_id, emoji, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.ManageMessages, "Manage Messages"]],
        `in #${target.name}`
      );

      const resolved = emoji ? await resolveEmoji(rest, guildId, emoji) : undefined;
      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      const reactionCount = (message.reactions ?? []).reduce(
        (sum, r) => sum + r.count,
        0
      );

      const gate = gateDestructive({
        tool: "clear_reactions",
        args: { channel: target.id, message_id, emoji: resolved?.api ?? "all" },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary: resolved
          ? `Would clear every ${resolved.display} reaction from the message.`
          : `Would clear all ${reactionCount} reaction(s) from the message.`,
        previewDetails: { total_reactions: reactionCount },
      });
      if (gate) return gate;

      if (resolved) {
        await rest.delete(
          Routes.channelMessageReaction(
            target.id,
            message_id,
            encodeURIComponent(resolved.api)
          )
        );
      } else {
        await rest.delete(Routes.channelMessageAllReactions(target.id, message_id));
      }
      return ok(
        resolved
          ? `Cleared ${resolved.display} reactions.`
          : "Cleared all reactions.",
        { cleared: resolved?.display ?? "all" }
      );
    })
  );

  server.registerTool(
    "get_reactions",
    {
      title: "Get reactions",
      description: "Who reacted to a message with a given emoji.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
        emoji: z.string(),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max users. Default 25."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ channel, guild, message_id, emoji, limit }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);
      const resolved = await resolveEmoji(rest, guildId, emoji);

      const users = (await rest.get(
        Routes.channelMessageReaction(
          target.id,
          message_id,
          encodeURIComponent(resolved.api)
        ),
        { query: new URLSearchParams({ limit: String(limit ?? 25) }) }
      )) as APIUser[];

      return ok(
        `${users.length} user(s) reacted with ${resolved.display}.`,
        {
          emoji: resolved.display,
          users: users.map((u) => ({
            id: u.id,
            name: u.global_name ?? u.username,
            bot: u.bot ?? false,
          })),
        }
      );
    })
  );

  server.registerTool(
    "create_poll",
    {
      title: "Create poll",
      description:
        "Post a native Discord poll: a question, two to ten answers, and " +
        "a duration of up to 32 days.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        question: z.string().min(1).max(300),
        answers: z.array(z.string().min(1).max(55)).min(2).max(10),
        duration_hours: z.number().int().min(1).max(768).optional()
          .describe("How long the poll runs. Default 24."),
        multi_select: z.boolean().optional()
          .describe("Allow choosing several answers."),
        content: z.string().max(2000).optional()
          .describe("Optional message text above the poll."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      channel,
      guild,
      question,
      answers,
      duration_hours,
      multi_select,
      content,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const perms = await botPermissions(rest, guildId, target);
      requirePermissions(
        perms,
        [[P.SendMessages, "Send Messages"]],
        `in #${target.name}`
      );

      const body: RESTPostAPIChannelMessageJSONBody = {
        ...(content ? { content } : {}),
        // Mentions suppressed in the optional text above the poll.
        allowed_mentions: { parse: [] },
        poll: {
          question: { text: question },
          answers: answers.map((text) => ({ poll_media: { text } })),
          duration: duration_hours ?? 24,
          allow_multiselect: multi_select ?? false,
          layout_type: 1 as never,
        },
      };
      const sent = (await rest.post(Routes.channelMessages(target.id), {
        body,
      })) as APIMessage;

      return ok(
        `Poll posted in #${target.name}: "${question}" with ` +
          `${answers.length} answers, running ${duration_hours ?? 24} hour(s).`,
        {
          id: sent.id,
          channel: { id: target.id, name: target.name },
          jump_link: `https://discord.com/channels/${guildId}/${target.id}/${sent.id}`,
        }
      );
    })
  );

  server.registerTool(
    "get_poll_results",
    {
      title: "Get poll results",
      description: "Current tallies for a poll message.",
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
      if (!message.poll) {
        return fail("That message has no poll.");
      }
      const counts = new Map(
        (message.poll.results?.answer_counts ?? []).map((c) => [c.id, c.count])
      );
      const results = message.poll.answers.map((a) => ({
        text: a.poll_media.text ?? "",
        votes: counts.get(a.answer_id) ?? 0,
      }));
      const total = results.reduce((sum, r) => sum + r.votes, 0);
      const finalized = message.poll.results?.is_finalized ?? false;

      return ok(
        `Poll "${message.poll.question.text}": ${total} vote(s)` +
          (finalized ? ", finished." : ", still open."),
        {
          question: message.poll.question.text,
          finalized,
          expires_at: message.poll.expiry,
          answers: results,
        }
      );
    })
  );

  server.registerTool(
    "end_poll",
    {
      title: "End poll",
      description:
        "Close one of the bot's own polls early and finalize the results.",
      inputSchema: {
        channel: z.string().describe("Channel name or ID."),
        guild: guildParam,
        message_id: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ channel, guild, message_id }) => {
      const { rest, guildId } = await enter(config, guild);
      const target = await resolveChannel(rest, guildId, channel, TEXT_BEARING_TYPES);

      const message = (await rest.get(
        Routes.channelMessage(target.id, message_id)
      )) as APIMessage;
      if (!message.poll) return fail("That message has no poll.");
      const botUser = await getBotUser(rest);
      if (message.author.id !== botUser.id) {
        return fail(
          "Only the poll's creator can end it early, and that poll was " +
            `posted by ${message.author.username}, not the bot.`
        );
      }

      await rest.post(Routes.expirePoll(target.id, message_id));
      return ok(`Ended the poll "${message.poll.question.text}".`, {
        ended: true,
        id: message_id,
      });
    })
  );
}
