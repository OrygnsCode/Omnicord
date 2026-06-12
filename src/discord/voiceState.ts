import { GatewayDispatchEvents } from "discord-api-types/v10";
import type {
  GatewayGuildCreateDispatchData,
  GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

// Voice presence cache. Discord has no REST endpoint that lists who is in
// a voice channel; that state lives only on the gateway. So the cache is
// seeded from the voice_states array in each GUILD_CREATE and kept current
// from VOICE_STATE_UPDATE dispatches. Anything read here is therefore only
// as complete as the gateway connection has been alive, which the voice
// tool states plainly.

export interface VoiceMemberState {
  user_id: string;
  channel_id: string;
  self_mute: boolean;
  self_deaf: boolean;
  server_mute: boolean;
  server_deaf: boolean;
  nick?: string | null;
  username?: string | null;
}

// guildId -> userId -> state. A null channel means the user left voice and
// the entry is dropped.
const byGuild = new Map<string, Map<string, VoiceMemberState>>();

function ensureGuild(guildId: string): Map<string, VoiceMemberState> {
  let g = byGuild.get(guildId);
  if (!g) {
    g = new Map();
    byGuild.set(guildId, g);
  }
  return g;
}

function applyState(
  guildId: string,
  state: {
    user_id: string;
    channel_id: string | null;
    self_mute?: boolean;
    self_deaf?: boolean;
    mute?: boolean;
    deaf?: boolean;
    member?: { nick?: string | null; user?: { username?: string } };
  }
): void {
  const guild = ensureGuild(guildId);
  if (!state.channel_id) {
    guild.delete(state.user_id);
    return;
  }
  guild.set(state.user_id, {
    user_id: state.user_id,
    channel_id: state.channel_id,
    self_mute: state.self_mute ?? false,
    self_deaf: state.self_deaf ?? false,
    server_mute: state.mute ?? false,
    server_deaf: state.deaf ?? false,
    nick: state.member?.nick ?? null,
    username: state.member?.user?.username ?? null,
  });
}

// Called from the single gateway dispatch handler.
export function handleVoiceDispatch(type: string, data: unknown): void {
  if (type === GatewayDispatchEvents.GuildCreate) {
    const g = data as GatewayGuildCreateDispatchData;
    if (!("id" in g)) return;
    const fresh = new Map<string, VoiceMemberState>();
    byGuild.set(g.id, fresh);
    for (const vs of g.voice_states ?? []) {
      if (vs.channel_id) {
        applyState(g.id, { ...vs, user_id: vs.user_id });
      }
    }
  } else if (type === GatewayDispatchEvents.VoiceStateUpdate) {
    const vs = data as GatewayVoiceStateUpdateDispatchData;
    if (vs.guild_id) applyState(vs.guild_id, vs);
  }
}

export function voiceMembersIn(guildId: string, channelId: string): VoiceMemberState[] {
  const guild = byGuild.get(guildId);
  if (!guild) return [];
  return [...guild.values()].filter((s) => s.channel_id === channelId);
}

export function hasGuildVoiceData(guildId: string): boolean {
  return byGuild.has(guildId);
}

// Test seam.
export function __resetVoiceState(): void {
  byGuild.clear();
}
