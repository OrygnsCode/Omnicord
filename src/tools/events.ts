import { z } from "zod";
import {
  Routes,
  PermissionFlagsBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  GuildScheduledEventPrivacyLevel,
} from "discord-api-types/v10";
import type {
  APIGuildScheduledEvent,
  RESTPostAPIGuildScheduledEventJSONBody,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
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
} from "./common.js";

// Scheduled events: voice, stage, and external.

const P = PermissionFlagsBits;

const STATUS_LABELS: Record<number, string> = {
  1: "scheduled",
  2: "active",
  3: "completed",
  4: "canceled",
};

const TYPE_LABELS: Record<number, string> = {
  1: "stage",
  2: "voice",
  3: "external",
};

function eventDigest(e: APIGuildScheduledEvent) {
  return {
    id: e.id,
    name: e.name,
    type: TYPE_LABELS[e.entity_type] ?? `type ${e.entity_type}`,
    status: STATUS_LABELS[e.status] ?? `status ${e.status}`,
    starts_at: e.scheduled_start_time,
    ends_at: e.scheduled_end_time ?? null,
    channel_id: e.channel_id ?? null,
    location: e.entity_metadata?.location ?? null,
    interested: e.user_count ?? 0,
    description: e.description ?? null,
  };
}

async function resolveEvent(
  rest: REST,
  guildId: string,
  query: string
): Promise<APIGuildScheduledEvent> {
  const events = (await rest.get(Routes.guildScheduledEvents(guildId), {
    query: new URLSearchParams({ with_user_count: "true" }),
  })) as APIGuildScheduledEvent[];
  const resolution = resolveOne(
    query,
    events.map((e) => ({ id: e.id, name: e.name, type: "event" }))
  );
  if ("match" in resolution) {
    const event = events.find((e) => e.id === resolution.match.id);
    if (event) return event;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No scheduled event matching "${query}".`)
      : fail(`Multiple events match "${query}". Pick one by ID.`, { candidates })
  );
}

function parseWhen(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ToolProblem(
      fail(`Could not parse ${label} "${value}". Use ISO format like 2026-07-01T19:00:00Z.`)
    );
  }
  return date.toISOString();
}

export function registerEventTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "list_events",
    {
      title: "List events",
      description:
        "Scheduled community events (the kind members RSVP to), with type, " +
        "time, status, and interest counts. For pending scheduled messages " +
        "see list_scheduled_messages; for live event subscriptions see " +
        "list_event_subscriptions.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const events = (await rest.get(Routes.guildScheduledEvents(guildId), {
        query: new URLSearchParams({ with_user_count: "true" }),
      })) as APIGuildScheduledEvent[];
      return ok(`${events.length} scheduled event(s).`, {
        events: events.map(eventDigest),
      });
    })
  );

  server.registerTool(
    "get_event",
    {
      title: "Get event",
      description: "One scheduled event in detail.",
      inputSchema: {
        event: z.string().describe("Event name or ID."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ event, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveEvent(rest, guildId, event);
      return ok(
        `${found.name}: ${TYPE_LABELS[found.entity_type]}, ` +
          `${STATUS_LABELS[found.status]}, starts ${found.scheduled_start_time}.`,
        eventDigest(found)
      );
    })
  );

  server.registerTool(
    "create_event",
    {
      title: "Create event",
      description:
        "Create a Discord scheduled community event that members see on the " +
        "events list and can mark interest in: a voice, stage, or external " +
        "(in-person or off-platform) event. This is not for sending a " +
        "message later (use schedule_message) or watching live activity " +
        "(use subscribe_events). Voice and stage events need a channel; " +
        "external events need a location and an end time.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(1).max(100),
        type: z.enum(["voice", "stage", "external"]),
        start_time: z.string().describe("ISO time, like 2026-07-01T19:00:00Z."),
        end_time: z.string().optional()
          .describe("Required for external events."),
        channel: z.string().optional()
          .describe("Voice or stage channel, for those event types."),
        location: z.string().max(100).optional()
          .describe("Where an external event happens."),
        description: z.string().max(1000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      guild,
      name,
      type,
      start_time,
      end_time,
      channel,
      location,
      description,
    }) => {
      const { rest, guildId } = await enter(config, guild);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.CreateEvents, "Create Events"]], "in this server");

      const start = parseWhen(start_time, "start_time");
      const warnings: string[] = [];
      if (new Date(start) <= new Date()) {
        return fail("start_time is in the past. Events need a future start.");
      }

      const body: RESTPostAPIGuildScheduledEventJSONBody = {
        name,
        privacy_level: GuildScheduledEventPrivacyLevel.GuildOnly,
        scheduled_start_time: start,
        entity_type: GuildScheduledEventEntityType.External,
        ...(description ? { description } : {}),
      };

      if (type === "external") {
        if (!location) return fail("External events need a location.");
        if (!end_time) return fail("External events need an end_time.");
        body.entity_type = GuildScheduledEventEntityType.External;
        body.entity_metadata = { location };
        body.scheduled_end_time = parseWhen(end_time, "end_time");
      } else {
        if (!channel) return fail(`A ${type} event needs a channel.`);
        const target = await resolveChannel(
          rest,
          guildId,
          channel,
          type === "voice" ? [2] : [13]
        );
        body.entity_type =
          type === "voice"
            ? GuildScheduledEventEntityType.Voice
            : GuildScheduledEventEntityType.StageInstance;
        body.channel_id = target.id;
        if (end_time) body.scheduled_end_time = parseWhen(end_time, "end_time");
      }

      const created = (await rest.post(Routes.guildScheduledEvents(guildId), {
        body,
        reason: "Created via Omnicord",
      })) as APIGuildScheduledEvent;

      return ok(
        `Scheduled "${created.name}" (${type}) for ${created.scheduled_start_time}.`,
        eventDigest(created),
        warnings
      );
    })
  );

  server.registerTool(
    "update_event",
    {
      title: "Update event",
      description:
        "Edit a scheduled event's details, or move it through its " +
        "lifecycle: status start makes it live, status end completes it.",
      inputSchema: {
        event: z.string().describe("Event name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(1000).optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        location: z.string().max(100).optional(),
        status: z.enum(["start", "end"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      event,
      guild,
      name,
      description,
      start_time,
      end_time,
      location,
      status,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveEvent(rest, guildId, event);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageEvents, "Manage Events"]], "in this server");

      const changes: string[] = [];
      const body: Record<string, unknown> = {};
      if (name !== undefined) {
        body.name = name;
        changes.push(`name to "${name}"`);
      }
      if (description !== undefined) {
        body.description = description;
        changes.push("description");
      }
      if (start_time !== undefined) {
        body.scheduled_start_time = parseWhen(start_time, "start_time");
        changes.push("start time");
      }
      if (end_time !== undefined) {
        body.scheduled_end_time = parseWhen(end_time, "end_time");
        changes.push("end time");
      }
      if (location !== undefined) {
        body.entity_metadata = { location };
        changes.push("location");
      }
      if (status !== undefined) {
        if (status === "start" && found.status !== GuildScheduledEventStatus.Scheduled) {
          return fail(
            `Only a scheduled event can be started; this one is ${STATUS_LABELS[found.status]}.`
          );
        }
        if (status === "end" && found.status !== GuildScheduledEventStatus.Active) {
          return fail(
            `Only an active event can be ended; this one is ${STATUS_LABELS[found.status]}.`
          );
        }
        body.status =
          status === "start"
            ? GuildScheduledEventStatus.Active
            : GuildScheduledEventStatus.Completed;
        changes.push(status === "start" ? "status to active" : "status to completed");
      }
      if (changes.length === 0) return fail("Pass at least one field to change.");

      const updated = (await rest.patch(
        Routes.guildScheduledEvent(guildId, found.id),
        { body, reason: "Updated via Omnicord" }
      )) as APIGuildScheduledEvent;

      return ok(`Updated "${updated.name}": ${changes.join(", ")}.`, eventDigest(updated));
    })
  );

  server.registerTool(
    "cancel_event",
    {
      title: "Cancel event",
      description:
        "Cancel and remove a scheduled event. Interested members lose the " +
        "listing. Safe to call directly: the first call changes nothing " +
        "and returns a preview plus a confirm_token; repeating the call " +
        "with the token cancels it.",
      inputSchema: {
        event: z.string().describe("Event name or ID."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ event, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveEvent(rest, guildId, event);

      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageEvents, "Manage Events"]], "in this server");

      const gate = gateDestructive({
        tool: "cancel_event",
        args: { event: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would cancel "${found.name}" (starts ${found.scheduled_start_time}, ` +
          `${found.user_count ?? 0} interested).`,
        previewDetails: eventDigest(found),
      });
      if (gate) return gate;

      await rest.delete(Routes.guildScheduledEvent(guildId, found.id), {
        reason: "Canceled via Omnicord",
      });
      return ok(`Canceled the event "${found.name}".`, {
        canceled: true,
        id: found.id,
      });
    })
  );

  server.registerTool(
    "get_event_attendees",
    {
      title: "Get event attendees",
      description: "Members who marked themselves interested in an event.",
      inputSchema: {
        event: z.string().describe("Event name or ID."),
        guild: guildParam,
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max entries. Default 25."),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ event, guild, limit }) => {
      const { rest, guildId } = await enter(config, guild);
      const found = await resolveEvent(rest, guildId, event);

      const users = (await rest.get(
        Routes.guildScheduledEventUsers(guildId, found.id),
        { query: new URLSearchParams({ limit: String(limit ?? 25) }) }
      )) as Array<{ user: { id: string; username: string; global_name?: string | null } }>;

      return ok(`${users.length} member(s) interested in "${found.name}".`, {
        event: { id: found.id, name: found.name },
        attendees: users.map((u) => ({
          id: u.user.id,
          name: u.user.global_name ?? u.user.username,
        })),
      });
    })
  );
}
