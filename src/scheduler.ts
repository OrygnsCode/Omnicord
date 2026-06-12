import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Routes } from "discord-api-types/v10";
import type { OmnicordConfig } from "./config.js";
import { getRest } from "./discord/client.js";
import { dataDir } from "./home.js";

// The message scheduler. Schedules persist as JSON files so they survive a
// restart, and the engine fires them with a periodic tick while the
// process is alive. A message that came due while Omnicord was off is sent
// on the next start (catch-up), then either removed or advanced to its
// next repeat. This is honest about its one limit: nothing fires while the
// process is down, so always-on delivery wants the hosted or container
// deployment, not a laptop that sleeps.

// Default tick is half a minute, fine for human-scheduled messages.
// Overridable so tests can run the loop fast.
function tickMs(): number {
  const raw = Number(process.env.OMNICORD_SCHEDULER_TICK_MS);
  return Number.isFinite(raw) && raw >= 250 ? raw : 30_000;
}

export type Repeat = "none" | "daily" | "weekly";

export interface ScheduledMessage {
  id: string;
  guild_id: string;
  channel_id: string;
  channel_name: string;
  content: string;
  send_at: string;
  repeat: Repeat;
  created_at: string;
  last_fired_at: string | null;
}

function storeDir(): string {
  return join(dataDir(), "schedules");
}

// Ids are randomBytes(8) hex: exactly 16 lowercase hex characters. Every
// path is built from a validated id so a tool argument can never escape
// the store directory through path traversal (e.g. "../../etc/x").
const ID_PATTERN = /^[a-f0-9]{16}$/;

export function isValidScheduleId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function fileFor(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error("Invalid schedule id.");
  }
  return join(storeDir(), `${id}.json`);
}

export function listSchedules(): ScheduledMessage[] {
  const dir = storeDir();
  if (!existsSync(dir)) return [];
  const out: ScheduledMessage[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as ScheduledMessage);
    } catch {
      // Skip a corrupt entry rather than failing the whole list.
    }
  }
  return out.sort((a, b) => a.send_at.localeCompare(b.send_at));
}

export function saveSchedule(input: {
  guildId: string;
  channelId: string;
  channelName: string;
  content: string;
  sendAt: Date;
  repeat: Repeat;
}): ScheduledMessage {
  const schedule: ScheduledMessage = {
    id: randomBytes(8).toString("hex"),
    guild_id: input.guildId,
    channel_id: input.channelId,
    channel_name: input.channelName,
    content: input.content,
    send_at: input.sendAt.toISOString(),
    repeat: input.repeat,
    created_at: new Date().toISOString(),
    last_fired_at: null,
  };
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(fileFor(schedule.id), JSON.stringify(schedule, null, 2) + "\n");
  return schedule;
}

export function cancelSchedule(id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  const file = fileFor(id);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

function advance(schedule: ScheduledMessage): void {
  if (schedule.repeat === "none") {
    cancelSchedule(schedule.id);
    return;
  }
  const next = new Date(schedule.send_at);
  const stepMs = schedule.repeat === "daily" ? 86_400_000 : 604_800_000;
  // Skip forward past now so a long downtime does not unleash a backlog.
  do {
    next.setTime(next.getTime() + stepMs);
  } while (next.getTime() <= Date.now());
  schedule.send_at = next.toISOString();
  schedule.last_fired_at = new Date().toISOString();
  writeFileSync(fileFor(schedule.id), JSON.stringify(schedule, null, 2) + "\n");
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function tick(config: OmnicordConfig): Promise<void> {
  if (running || !config.token) return;
  running = true;
  try {
    const rest = getRest(config);
    for (const schedule of listSchedules()) {
      if (new Date(schedule.send_at).getTime() > Date.now()) continue;
      try {
        await rest.post(Routes.channelMessages(schedule.channel_id), {
          body: {
            content: schedule.content,
            allowed_mentions: { parse: [] },
          },
        });
        advance(schedule);
      } catch (err) {
        // A channel that vanished or a permission loss should not wedge
        // the scheduler. Drop a one-shot; leave a repeat to try again.
        const status = (err as { status?: number }).status;
        if (schedule.repeat === "none" && (status === 403 || status === 404)) {
          cancelSchedule(schedule.id);
        }
        console.error(
          `omnicord scheduler: failed to send ${schedule.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  } finally {
    running = false;
  }
}

export function startScheduler(config: OmnicordConfig): void {
  if (timer || !config.token) return;
  // Catch up immediately on start, then tick.
  void tick(config);
  timer = setInterval(() => void tick(config), tickMs());
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
