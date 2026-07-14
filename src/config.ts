import { config as loadDotenv } from "dotenv";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Load .env from the working directory when present, then the package
// root, then ~/.omnicord. The package-root fallback matters because MCP
// clients spawn this server from whatever directory they please, and a
// developer's .env lives next to package.json. The home fallback is where
// the wizard saves the token for installed copies (npx, global installs),
// since package-manager directories get deleted and replaced. dotenv never
// overrides variables that are already set, so real environment variables
// always win over every file.
// quiet:true matters too: dotenv v17 prints a banner to stdout by default,
// and anything on stdout that is not a JSON-RPC message breaks the stdio
// transport.
const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("../package.json");

// OMNICORD_HOME, when set, is the config directory the wizard writes to and
// the server reads from first, so the two always agree (see home.ts). It is
// loaded before the other files so it wins among them; a real environment
// variable still overrides every file.
const configHome = process.env.OMNICORD_HOME?.trim();
if (configHome) loadDotenv({ path: join(configHome, ".env"), quiet: true });
loadDotenv({ quiet: true });
loadDotenv({ path: join(dirname(packageJsonPath), ".env"), quiet: true });
loadDotenv({ path: join(homedir(), ".omnicord", ".env"), quiet: true });

const pkg = require(packageJsonPath) as {
  version: string;
};

export const VERSION: string = pkg.version;

// A single Discord bot Omnicord can act as. Multiple bots let one install
// drive several servers (or a test bot and a real bot) without swapping the
// token. One bot is always marked the default: it is what single-bot call
// sites use and what ambiguous requests fall back to.
export interface BotConfig {
  name: string;
  token: string;
  isDefault: boolean;
}

export interface OmnicordConfig {
  // Every configured bot. Empty when no token is set anywhere.
  bots: BotConfig[];
  // The default bot's token, or undefined when nothing is configured. Kept
  // as a top-level field so the existing single-bot call sites (getRest,
  // the gateway, the scheduler, the boot banners) keep working unchanged
  // while the multi-bot routing is built on top of `bots`.
  token: string | undefined;
  // Optional default guild ID. Tools accept an explicit guild and fall
  // back to this.
  defaultGuild: string | undefined;
}

// Shape of a bots.json file. Hand-editable, and also written by the wizard.
// Everything is `unknown` because it is user-supplied and must be validated.
interface RawBotEntry {
  name?: unknown;
  token?: unknown;
  default?: unknown;
}
interface RawBotsFile {
  bots?: unknown;
}

// Pure: given a parsed bots.json (or undefined) and the DISCORD_TOKEN from
// the environment, produce the normalized bot list. Exactly one bot ends up
// default, names are unique so a bot can be selected unambiguously, and
// duplicate tokens collapse to one entry. No I/O, so it is unit-testable in
// isolation.
export function buildBots(
  file: RawBotsFile | undefined,
  envToken: string | undefined
): BotConfig[] {
  const collected: Array<{ name: string; token: string; wantsDefault: boolean }> =
    [];
  const seenTokens = new Set<string>();

  const entries = Array.isArray(file?.bots)
    ? (file.bots as RawBotEntry[])
    : [];
  let index = 0;
  for (const entry of entries) {
    index += 1;
    const token = typeof entry?.token === "string" ? entry.token.trim() : "";
    if (!token || seenTokens.has(token)) continue;
    seenTokens.add(token);
    const name =
      typeof entry?.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : `bot${index}`;
    collected.push({ name, token, wantsDefault: entry?.default === true });
  }

  // A DISCORD_TOKEN from the environment is a bot too. It does not duplicate
  // a bots.json entry that already carries the same token.
  const env = envToken?.trim();
  if (env && !seenTokens.has(env)) {
    seenTokens.add(env);
    collected.push({ name: "default", token: env, wantsDefault: false });
  }

  if (collected.length === 0) return [];

  // Default selection: an explicit default:true wins (first one, if several
  // claim it); otherwise the environment token; otherwise the first bot.
  let defaultIdx = collected.findIndex((b) => b.wantsDefault);
  if (defaultIdx === -1) {
    defaultIdx = env ? collected.findIndex((b) => b.token === env) : 0;
  }
  if (defaultIdx === -1) defaultIdx = 0;

  // Make names unique so later phases can select a bot by name with no
  // ambiguity, without discarding the user's chosen label.
  const usedNames = new Set<string>();
  return collected.map((b, i) => {
    let name = b.name;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${b.name}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name.toLowerCase());
    return { name, token: b.token, isDefault: i === defaultIdx };
  });
}

// Discover a bots.json the same way .env is discovered: working directory,
// then package root, then ~/.omnicord. The first one found wins.
function readBotsFile(): RawBotsFile | undefined {
  const home = process.env.OMNICORD_HOME?.trim();
  const candidates = [
    ...(home ? [join(home, "bots.json")] : []),
    join(process.cwd(), "bots.json"),
    join(dirname(packageJsonPath), "bots.json"),
    join(homedir(), ".omnicord", "bots.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RawBotsFile;
    } catch (err) {
      // A malformed bots.json must not crash the server, and must not write
      // to stdout (that breaks the stdio transport). Warn on stderr and fall
      // back to whatever else is configured; diagnostics can flag it later.
      console.error(
        `[omnicord] Ignoring ${path}: not valid JSON (${(err as Error).message}).`
      );
      return undefined;
    }
  }
  return undefined;
}

export function loadConfig(): OmnicordConfig {
  const bots = buildBots(readBotsFile(), process.env.DISCORD_TOKEN);
  const defaultBot = bots.find((b) => b.isDefault);
  const defaultGuild = process.env.OMNICORD_GUILD?.trim() || undefined;
  return { bots, token: defaultBot?.token, defaultGuild };
}
