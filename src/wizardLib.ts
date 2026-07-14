import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { PERMISSION_PRESETS } from "./discord/preflight.js";

// The pure half of the setup wizard. Everything here is a function of its
// inputs so the logic that touches user config files is unit tested
// without a terminal or a filesystem.

// Merges an omnicord entry into a client config file's JSON text. All
// existing content survives untouched; only mcpServers.omnicord is added
// or replaced. Returns the new text, 2-space indented with a trailing
// newline, which matches how these files are machine-written.
export function mergeClientConfig(
  existingText: string | undefined,
  entry: { command: string; args: string[] }
): string {
  let parsed: Record<string, unknown> = {};
  if (existingText && existingText.trim().length > 0) {
    parsed = JSON.parse(existingText) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config file is not a JSON object.");
    }
  }
  const servers =
    typeof parsed.mcpServers === "object" &&
    parsed.mcpServers !== null &&
    !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  servers.omnicord = { command: entry.command, args: entry.args };
  parsed.mcpServers = servers;
  return JSON.stringify(parsed, null, 2) + "\n";
}

// Sets KEY=value in dotenv-style text, replacing an existing line or
// appending one. Comments and unrelated lines survive byte for byte.
export function envUpsert(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

// Remove a KEY=... line from dotenv text, preserving every other line and
// comment. Used when a single bot is moved out of .env into bots.json so the
// old token does not linger and load as an extra bot.
export function envRemoveKey(content: string, key: string): string {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const kept = content.split(/\r?\n/).filter((line) => !pattern.test(line));
  return kept.join("\n").replace(/\n*$/, "\n");
}

export function inviteUrl(applicationId: string, permissions: bigint): string {
  return (
    "https://discord.com/oauth2/authorize" +
    `?client_id=${applicationId}&scope=bot&permissions=${permissions}`
  );
}

// Invite permission choices. The recommended bundle is the admin preset:
// everything Omnicord's tools need without the Administrator bit, so the
// bot cannot bypass channel permission overwrites. Administrator is a
// legitimate choice for owners who would rather not think about
// permissions; the safety gate confirms destructive actions regardless
// of which level is granted.
export const INVITE_CHOICES: Array<{
  key: string;
  label: string;
  permissions: bigint;
}> = [
  {
    key: "recommended",
    label:
      "Recommended: manage channels, roles, messages, members, webhooks, " +
      "and events, without the Administrator bit",
    permissions: PERMISSION_PRESETS.admin,
  },
  {
    key: "moderation",
    label: "Moderation only: messages, timeouts, kicks, voice control",
    permissions: PERMISSION_PRESETS.moderator,
  },
  {
    key: "administrator",
    label:
      "Full Administrator: every permission, nothing to think about; " +
      "the safety gate still confirms destructive actions",
    permissions: PermissionFlagsBits.Administrator,
  },
];

export interface ConfigCandidate {
  client: string;
  label: string;
  path: string;
  // The config file already exists: the client has MCP servers set up.
  exists: boolean;
  // The client looks installed (its config directory is present) even if
  // it has no MCP config file yet. Offered so a first-time MCP user is
  // not dropped to the manual snippet; the wizard creates the file.
  appPresent: boolean;
}

// Known client config locations. For each, the wizard records whether the
// config file exists and whether the client looks installed (its config
// directory is present), so it can offer a client even before that client
// has any MCP config file. Claude Code's project option is always offered.
// The Microsoft Store build of Claude Desktop keeps its config under a
// package directory whose name is stable per publisher, found by scanning
// rather than hardcoding the hash. This function only reads the disk; it
// never creates or writes anything.
export function clientConfigCandidates(env: {
  platform: NodeJS.Platform;
  homedir: string;
  appData?: string;
  localAppData?: string;
  cwd: string;
}): ConfigCandidate[] {
  const out: ConfigCandidate[] = [];

  const push = (client: string, label: string, path: string) => {
    out.push({
      client,
      label,
      path,
      exists: existsSync(path),
      // Installed if the config directory exists, even without the file.
      appPresent: existsSync(dirname(path)),
    });
  };

  if (env.platform === "win32") {
    if (env.appData) {
      push(
        "claude-desktop",
        "Claude Desktop",
        join(env.appData, "Claude", "claude_desktop_config.json")
      );
    }
    if (env.localAppData) {
      const packages = join(env.localAppData, "Packages");
      try {
        for (const name of readdirSync(packages)) {
          if (!name.startsWith("Claude_")) continue;
          push(
            "claude-desktop",
            "Claude Desktop (Microsoft Store build)",
            join(
              packages,
              name,
              "LocalCache",
              "Roaming",
              "Claude",
              "claude_desktop_config.json"
            )
          );
        }
      } catch {
        // No Packages directory means no Store build; nothing to add.
      }
    }
  } else if (env.platform === "darwin") {
    push(
      "claude-desktop",
      "Claude Desktop",
      join(
        env.homedir,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      )
    );
  } else {
    push(
      "claude-desktop",
      "Claude Desktop",
      join(env.homedir, ".config", "Claude", "claude_desktop_config.json")
    );
  }

  push("cursor", "Cursor (global)", join(env.homedir, ".cursor", "mcp.json"));
  push("cursor", "Cursor (this project)", join(env.cwd, ".cursor", "mcp.json"));
  push(
    "windsurf",
    "Windsurf",
    join(env.homedir, ".codeium", "windsurf", "mcp_config.json")
  );
  push("claude-code", "Claude Code (this project)", join(env.cwd, ".mcp.json"));

  return out;
}

// --- Multi-bot config (bots.json) ---
//
// The wizard writes additional bots to a bots.json next to the .env. These
// helpers are the pure half of that: parsing, naming, and serializing, so the
// file-writing logic is unit tested without a terminal.

export interface WizardBot {
  name: string;
  token: string;
  default?: boolean;
}

// Parse bots.json text into entries. Tolerant of empty, missing, or malformed
// input (returns an empty list) so a broken file never crashes the wizard.
export function parseBotsFile(content: string | undefined): WizardBot[] {
  if (!content || !content.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const raw = (parsed as { bots?: unknown })?.bots;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => b as { name?: unknown; token?: unknown; default?: unknown })
    .filter((b) => typeof b?.token === "string" && b.token.trim().length > 0)
    .map((b) => ({
      name: typeof b.name === "string" ? b.name.trim() : "",
      token: (b.token as string).trim(),
      default: b.default === true,
    }));
}

// Return desired if free, otherwise desired-2, desired-3, ... comparing
// case-insensitively so names stay unambiguous when selected later.
export function uniqueBotName(desired: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(desired.toLowerCase())) return desired;
  let n = 2;
  while (lower.has(`${desired}-${n}`.toLowerCase())) n += 1;
  return `${desired}-${n}`;
}

// A short, file-safe, unique bot name suggested from a Discord username.
export function suggestBotName(username: string, taken: string[]): string {
  const base =
    username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "bot";
  return uniqueBotName(base, taken);
}

// Enforce exactly one default: the first bot flagged default wins; if none is
// flagged, the first bot becomes default.
function ensureOneDefault(bots: WizardBot[]): WizardBot[] {
  if (bots.length === 0) return bots;
  let seen = false;
  const out = bots.map((b) => {
    if (b.default && !seen) {
      seen = true;
      return { ...b, default: true };
    }
    return { ...b, default: false };
  });
  if (!seen) out[0] = { ...out[0], default: true };
  return out;
}

// Serialize a bot list to bots.json text: 2-space indent, trailing newline,
// exactly one default.
export function serializeBotsFile(bots: WizardBot[]): string {
  return (
    JSON.stringify(
      {
        bots: ensureOneDefault(bots).map((b) => ({
          name: b.name,
          token: b.token,
          ...(b.default ? { default: true } : {}),
        })),
      },
      null,
      2
    ) + "\n"
  );
}

// Add a bot to bots.json text. Dedups by token (a token already present is not
// duplicated; a missing name is filled in). The chosen name is uniquified if it
// collides. The first bot in an otherwise-empty file becomes the default.
export function addBotToBotsFile(
  content: string | undefined,
  bot: { name: string; token: string }
): string {
  const bots = parseBotsFile(content);
  const token = bot.token.trim();
  const existing = bots.find((b) => b.token === token);
  if (existing) {
    if (!existing.name && bot.name) existing.name = bot.name;
    return serializeBotsFile(bots);
  }
  const name = uniqueBotName(
    bot.name || "bot",
    bots.map((b) => b.name).filter(Boolean)
  );
  bots.push({ name, token, default: bots.length === 0 });
  return serializeBotsFile(bots);
}
