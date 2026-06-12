import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import {
  eventBus,
  SUBSCRIBABLE_TYPES,
} from "../discord/gatewayEvents.js";
import { getGatewayState, getPortalIntents } from "../discord/gateway.js";
import { ok, fail } from "../envelope.js";
import { enter, guarded, guildParam, resolveChannel } from "./common.js";

// Real-time event subscriptions over the gateway connection. Delivery is
// buffered: subscribe, let things happen, then poll get_recent_events.
// That works in every MCP client today; push delivery can layer on later.

const TYPE_NAMES = Object.keys(SUBSCRIBABLE_TYPES);

// A ceiling on concurrent subscriptions, so a runaway caller cannot grow
// unbounded buffers. Each subscription already caps its own buffer.
const MAX_SUBSCRIPTIONS = 50;

function requireGateway(): string | null {
  const state = getGatewayState();
  if (state.status === "connected" || state.status === "connecting") return null;
  if (state.status === "off") {
    return (
      `The gateway is off (${state.reason}), so no events are flowing. ` +
      "Events need a DISCORD_TOKEN and OMNICORD_GATEWAY not set to off."
    );
  }
  return `The gateway is in an error state: ${state.message}`;
}

export function registerRealtimeTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "subscribe_events",
    {
      title: "Subscribe to events",
      description:
        "Watch the server live: start recording real-time activity as it " +
        "happens (messages, joins and leaves, reactions, channel and role " +
        "changes, bans, voice movement) into a buffer you then read with " +
        "get_recent_events. Use this to observe what is going on now. It is " +
        "not for scheduled community events (create_event) or timed " +
        "messages (schedule_message). Available types: " +
        TYPE_NAMES.join(", ") +
        ".",
      inputSchema: {
        types: z.array(z.enum(TYPE_NAMES as [string, ...string[]])).min(1)
          .describe("Which event types to record."),
        guild: guildParam,
        channel: z.string().optional()
          .describe("Only record events from this channel."),
        include_bots: z.boolean().optional()
          .describe("Also record events caused by bots, including this one. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ types, guild, channel, include_bots }) => {
      const gatewayProblem = requireGateway();
      if (gatewayProblem) return fail(gatewayProblem);

      if (eventBus.list().length >= MAX_SUBSCRIPTIONS) {
        return fail(
          `Already at the ${MAX_SUBSCRIPTIONS}-subscription limit. ` +
            "Remove some with unsubscribe_events first."
        );
      }

      let channelId: string | null = null;
      let channelName: string | undefined;
      if (channel) {
        const { rest, guildId } = await enter(config, guild);
        const target = await resolveChannel(rest, guildId, channel);
        channelId = target.id;
        channelName = target.name ?? undefined;
      }

      // Types that depend on a privileged intent silently produce nothing
      // when the portal toggle is off; warn instead of letting that
      // confuse anyone.
      const warnings: string[] = [];
      const portal = getPortalIntents();
      if (portal) {
        for (const type of types) {
          const needs = SUBSCRIBABLE_TYPES[type];
          if (needs && !portal[needs]) {
            warnings.push(
              `${type} needs the ${needs} intent, which is off in the ` +
                "Developer Portal; those events will not arrive until it " +
                "is enabled and Omnicord restarts."
            );
          }
        }
      }

      const sub = eventBus.subscribe({
        id: randomBytes(8).toString("hex"),
        types,
        channelId,
        includeBots: include_bots ?? false,
      });

      return ok(
        `Subscribed to ${types.join(", ")}` +
          (channelName ? ` in #${channelName}` : "") +
          `. Events buffer under subscription ${sub.id}; read them with ` +
          "get_recent_events.",
        {
          subscription_id: sub.id,
          types,
          channel_id: channelId,
          include_bots: sub.includeBots,
        },
        warnings
      );
    })
  );

  server.registerTool(
    "get_recent_events",
    {
      title: "Get recent events",
      description:
        "Read and clear buffered events from a subscription, oldest first.",
      inputSchema: {
        subscription_id: z.string(),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max events to return. Default 25."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ subscription_id, limit }) => {
      const result = eventBus.drain(subscription_id, limit ?? 25);
      if (!result) {
        return fail(
          `No subscription ${subscription_id}. It may have been removed, ` +
            "or the server restarted; subscribe again."
        );
      }
      return ok(
        `${result.events.length} event(s)` +
          (result.remaining > 0 ? `, ${result.remaining} more buffered` : "") +
          (result.dropped > 0
            ? `, ${result.dropped} dropped to the buffer cap`
            : "") +
          ".",
        result
      );
    })
  );

  server.registerTool(
    "list_event_subscriptions",
    {
      title: "List event subscriptions",
      description: "Active event subscriptions and their buffer sizes.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const subs = eventBus.list();
      return ok(`${subs.length} active subscription(s).`, {
        gateway: getGatewayState(),
        subscriptions: subs.map((s) => ({
          id: s.id,
          types: [...s.types],
          channel_id: s.channelId,
          include_bots: s.includeBots,
          buffered: s.buffer.length,
          created_at: s.createdAt,
        })),
      });
    }
  );

  server.registerTool(
    "unsubscribe_events",
    {
      title: "Unsubscribe from events",
      description: "Stop recording and discard a subscription's buffer.",
      inputSchema: { subscription_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ subscription_id }) => {
      const removed = eventBus.unsubscribe(subscription_id);
      if (!removed) return fail(`No subscription ${subscription_id}.`);
      return ok(`Subscription ${subscription_id} removed.`, { removed: true });
    })
  );
}
