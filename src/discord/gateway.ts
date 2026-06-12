import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import {
  Routes,
  PresenceUpdateStatus,
  GatewayOpcodes,
  ActivityType,
} from "discord-api-types/v10";
import type { RESTGetCurrentApplicationResult } from "discord-api-types/v10";
import type { OmnicordConfig } from "../config.js";
import { getRest } from "./client.js";
import { readIntents, type IntentStatus } from "./intents.js";
import { gatewayIntentBits, normalizeDispatch, eventBus } from "./gatewayEvents.js";
import { handleVoiceDispatch } from "./voiceState.js";

// The live gateway connection: one per process, shared by every transport
// session. It does two jobs: the bot shows as online while Omnicord runs,
// and dispatch events feed the subscription bus. A gateway failure never
// takes the server down; every REST tool keeps working and the status
// here explains what happened.

export type GatewayState =
  | { status: "off"; reason: string }
  | { status: "connecting" }
  | { status: "connected"; since: string; intents: IntentStatus }
  | { status: "error"; message: string };

let state: GatewayState = { status: "off", reason: "not started" };
let manager: WebSocketManager | undefined;
let portalIntents: IntentStatus | undefined;

export function getGatewayState(): GatewayState {
  return state;
}

export function getPortalIntents(): IntentStatus | undefined {
  return portalIntents;
}

export async function startGateway(config: OmnicordConfig): Promise<void> {
  if (process.env.OMNICORD_GATEWAY?.toLowerCase() === "off") {
    state = { status: "off", reason: "disabled by OMNICORD_GATEWAY=off" };
    return;
  }
  if (!config.token) {
    state = { status: "off", reason: "no DISCORD_TOKEN configured" };
    return;
  }

  try {
    state = { status: "connecting" };
    const rest = getRest(config);
    const app = (await rest.get(
      Routes.currentApplication()
    )) as RESTGetCurrentApplicationResult;
    portalIntents = readIntents(app.flags ?? 0);

    manager = new WebSocketManager({
      token: config.token,
      intents: gatewayIntentBits(portalIntents),
      rest,
      initialPresence: {
        status: PresenceUpdateStatus.Online,
        since: null,
        afk: false,
        activities: [],
      },
    });

    manager.on(WebSocketShardEvents.Dispatch, (payload) => {
      handleVoiceDispatch(payload.t, payload.d);
      const draft = normalizeDispatch(payload.t, payload.d);
      if (draft) eventBus.record(draft);
    });
    manager.on(WebSocketShardEvents.Ready, () => {
      state = {
        status: "connected",
        since: new Date().toISOString(),
        intents: portalIntents as IntentStatus,
      };
      console.error("omnicord gateway connected, bot presence is online");
    });
    manager.on(WebSocketShardEvents.Closed, (code) => {
      // The shard reconnects on its own; surface the state meanwhile.
      if (state.status === "connected") {
        state = { status: "connecting" };
      }
      console.error(`omnicord gateway closed with code ${code}, reconnecting`);
    });
    manager.on(WebSocketShardEvents.Error, (error) => {
      console.error(`omnicord gateway error: ${error.message}`);
    });

    await manager.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = { status: "error", message };
    console.error(`omnicord gateway failed to start: ${message}`);
  }
}

// Presence updates ride the live gateway connection. Returns an error
// string when there is no connection to ride.
export async function setPresence(options: {
  status: "online" | "idle" | "dnd" | "invisible";
  activityText?: string;
}): Promise<string | null> {
  if (!manager || state.status !== "connected") {
    return (
      "The gateway is not connected, so presence cannot change. " +
      "Check run_setup_check for the gateway state."
    );
  }
  await manager.send(0, {
    op: GatewayOpcodes.PresenceUpdate,
    d: {
      since: null,
      afk: false,
      status: options.status as PresenceUpdateStatus,
      activities: options.activityText
        ? [
            {
              name: options.activityText,
              type: ActivityType.Custom,
              state: options.activityText,
            },
          ]
        : [],
    },
  });
  return null;
}

export async function stopGateway(): Promise<void> {
  if (manager) {
    try {
      await manager.destroy();
    } catch {
      // Already down; nothing to release.
    }
    manager = undefined;
  }
  state = { status: "off", reason: "stopped" };
}
