import { GatewayIntentBits, GatewayDispatchEvents } from "discord-api-types/v10";
import type {
  GatewayChannelCreateDispatchData,
  GatewayChannelDeleteDispatchData,
  GatewayGuildBanAddDispatchData,
  GatewayGuildBanRemoveDispatchData,
  GatewayGuildMemberAddDispatchData,
  GatewayGuildMemberRemoveDispatchData,
  GatewayGuildRoleCreateDispatchData,
  GatewayGuildRoleDeleteDispatchData,
  GatewayGuildRoleUpdateDispatchData,
  GatewayMessageCreateDispatchData,
  GatewayMessageDeleteDispatchData,
  GatewayMessageReactionAddDispatchData,
  GatewayMessageReactionRemoveDispatchData,
  GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";
import type { IntentStatus } from "./intents.js";

// The pure half of the gateway: intent selection, dispatch normalization,
// and the subscription event bus. No sockets here, so all of it is unit
// tested without Discord.

// Which gateway intents to request, derived from what the Developer
// Portal actually has enabled. Requesting a privileged intent whose
// toggle is off makes Discord close the connection with code 4014, so
// the request set is computed instead of hardcoded.
export function gatewayIntentBits(portal: IntentStatus): number {
  let bits =
    GatewayIntentBits.Guilds |
    GatewayIntentBits.GuildModeration |
    GatewayIntentBits.GuildMessageReactions |
    GatewayIntentBits.GuildVoiceStates;
  if (portal.members) bits |= GatewayIntentBits.GuildMembers;
  if (portal.messageContent) {
    bits |= GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;
  }
  return bits;
}

// The event types a subscription can ask for, with the portal intent each
// one depends on (null when an unprivileged intent covers it).
export const SUBSCRIBABLE_TYPES: Record<string, keyof IntentStatus | null> = {
  message_created: "messageContent",
  message_deleted: "messageContent",
  member_joined: "members",
  member_left: "members",
  reaction_added: null,
  reaction_removed: null,
  channel_created: null,
  channel_deleted: null,
  role_created: null,
  role_updated: null,
  role_deleted: null,
  ban_added: null,
  ban_removed: null,
  voice_state_changed: null,
};

export interface NormalizedEvent {
  seq: number;
  type: string;
  at: string;
  guild_id: string | null;
  channel_id: string | null;
  actor: { id: string; name: string | null; bot: boolean } | null;
  data: Record<string, unknown>;
}

type Draft = Omit<NormalizedEvent, "seq" | "at">;

function user(
  u: { id: string; username?: string; global_name?: string | null; bot?: boolean } | undefined
): NormalizedEvent["actor"] {
  if (!u) return null;
  return {
    id: u.id,
    name: u.global_name ?? u.username ?? null,
    bot: u.bot ?? false,
  };
}

// Dispatch payloads come in as the raw gateway shapes; each normalizer
// reduces one to the small digest subscribers actually want. Unhandled
// dispatch types return null and cost nothing.
export function normalizeDispatch(t: string, d: unknown): Draft | null {
  switch (t) {
    case GatewayDispatchEvents.MessageCreate: {
      const m = d as GatewayMessageCreateDispatchData;
      return {
        type: "message_created",
        guild_id: m.guild_id ?? null,
        channel_id: m.channel_id,
        actor: user(m.author),
        data: {
          message_id: m.id,
          content: (m.content ?? "").slice(0, 300),
          attachments: (m.attachments ?? []).length,
        },
      };
    }
    case GatewayDispatchEvents.MessageDelete: {
      const m = d as GatewayMessageDeleteDispatchData;
      return {
        type: "message_deleted",
        guild_id: m.guild_id ?? null,
        channel_id: m.channel_id,
        actor: null,
        data: { message_id: m.id },
      };
    }
    case GatewayDispatchEvents.GuildMemberAdd: {
      const m = d as GatewayGuildMemberAddDispatchData;
      return {
        type: "member_joined",
        guild_id: m.guild_id,
        channel_id: null,
        actor: user(m.user),
        data: {},
      };
    }
    case GatewayDispatchEvents.GuildMemberRemove: {
      const m = d as GatewayGuildMemberRemoveDispatchData;
      return {
        type: "member_left",
        guild_id: m.guild_id,
        channel_id: null,
        actor: user(m.user),
        data: {},
      };
    }
    case GatewayDispatchEvents.MessageReactionAdd: {
      const r = d as GatewayMessageReactionAddDispatchData;
      return {
        type: "reaction_added",
        guild_id: r.guild_id ?? null,
        channel_id: r.channel_id,
        actor: user(r.member?.user) ?? {
          id: r.user_id,
          name: null,
          bot: false,
        },
        data: {
          message_id: r.message_id,
          emoji: r.emoji.name ?? r.emoji.id ?? "?",
        },
      };
    }
    case GatewayDispatchEvents.MessageReactionRemove: {
      const r = d as GatewayMessageReactionRemoveDispatchData;
      return {
        type: "reaction_removed",
        guild_id: r.guild_id ?? null,
        channel_id: r.channel_id,
        actor: { id: r.user_id, name: null, bot: false },
        data: {
          message_id: r.message_id,
          emoji: r.emoji.name ?? r.emoji.id ?? "?",
        },
      };
    }
    case GatewayDispatchEvents.ChannelCreate:
    case GatewayDispatchEvents.ChannelDelete: {
      const c = d as GatewayChannelCreateDispatchData | GatewayChannelDeleteDispatchData;
      return {
        type:
          t === GatewayDispatchEvents.ChannelCreate
            ? "channel_created"
            : "channel_deleted",
        guild_id: "guild_id" in c ? (c.guild_id ?? null) : null,
        channel_id: c.id,
        actor: null,
        data: { name: "name" in c ? c.name : null, channel_type: c.type },
      };
    }
    case GatewayDispatchEvents.GuildRoleCreate: {
      const r = d as GatewayGuildRoleCreateDispatchData;
      return {
        type: "role_created",
        guild_id: r.guild_id,
        channel_id: null,
        actor: null,
        data: { role_id: r.role.id, name: r.role.name },
      };
    }
    case GatewayDispatchEvents.GuildRoleUpdate: {
      const r = d as GatewayGuildRoleUpdateDispatchData;
      return {
        type: "role_updated",
        guild_id: r.guild_id,
        channel_id: null,
        actor: null,
        data: { role_id: r.role.id, name: r.role.name },
      };
    }
    case GatewayDispatchEvents.GuildRoleDelete: {
      const r = d as GatewayGuildRoleDeleteDispatchData;
      return {
        type: "role_deleted",
        guild_id: r.guild_id,
        channel_id: null,
        actor: null,
        data: { role_id: r.role_id },
      };
    }
    case GatewayDispatchEvents.GuildBanAdd: {
      const b = d as GatewayGuildBanAddDispatchData;
      return {
        type: "ban_added",
        guild_id: b.guild_id,
        channel_id: null,
        actor: user(b.user),
        data: {},
      };
    }
    case GatewayDispatchEvents.GuildBanRemove: {
      const b = d as GatewayGuildBanRemoveDispatchData;
      return {
        type: "ban_removed",
        guild_id: b.guild_id,
        channel_id: null,
        actor: user(b.user),
        data: {},
      };
    }
    case GatewayDispatchEvents.VoiceStateUpdate: {
      const v = d as GatewayVoiceStateUpdateDispatchData;
      return {
        type: "voice_state_changed",
        guild_id: v.guild_id ?? null,
        channel_id: v.channel_id,
        actor: user(v.member?.user) ?? { id: v.user_id, name: null, bot: false },
        data: { joined: v.channel_id !== null },
      };
    }
    default:
      return null;
  }
}

// Ring-buffered subscriptions. Buffer delivery works in every MCP client:
// subscribe, act, then poll get_recent_events. Push notification delivery
// can layer on later without changing this contract.
const BUFFER_CAP = 500;

export interface Subscription {
  id: string;
  types: Set<string>;
  channelId: string | null;
  includeBots: boolean;
  buffer: NormalizedEvent[];
  dropped: number;
  createdAt: string;
}

export class EventBus {
  private subscriptions = new Map<string, Subscription>();
  private seq = 0;

  subscribe(options: {
    id: string;
    types: string[];
    channelId?: string | null;
    includeBots?: boolean;
  }): Subscription {
    const sub: Subscription = {
      id: options.id,
      types: new Set(options.types),
      channelId: options.channelId ?? null,
      includeBots: options.includeBots ?? false,
      buffer: [],
      dropped: 0,
      createdAt: new Date().toISOString(),
    };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  unsubscribe(id: string): boolean {
    return this.subscriptions.delete(id);
  }

  get(id: string): Subscription | undefined {
    return this.subscriptions.get(id);
  }

  list(): Subscription[] {
    return [...this.subscriptions.values()];
  }

  record(draft: Draft): void {
    if (this.subscriptions.size === 0) return;
    const event: NormalizedEvent = {
      ...draft,
      seq: ++this.seq,
      at: new Date().toISOString(),
    };
    for (const sub of this.subscriptions.values()) {
      if (!sub.types.has(event.type)) continue;
      if (sub.channelId && event.channel_id !== sub.channelId) continue;
      if (!sub.includeBots && event.actor?.bot) continue;
      sub.buffer.push(event);
      if (sub.buffer.length > BUFFER_CAP) {
        sub.buffer.shift();
        sub.dropped += 1;
      }
    }
  }

  drain(id: string, limit: number): { events: NormalizedEvent[]; remaining: number; dropped: number } | undefined {
    const sub = this.subscriptions.get(id);
    if (!sub) return undefined;
    const events = sub.buffer.splice(0, limit);
    const dropped = sub.dropped;
    sub.dropped = 0;
    return { events, remaining: sub.buffer.length, dropped };
  }
}

export const eventBus = new EventBus();
