import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { VERSION } from "./config.js";
import { envFilePath, botsFilePath, IS_INSTALLED } from "./home.js";
import { bold, cyan, dim, green, red, rule, underline, yellow } from "./term.js";
import { readIntents, type IntentStatus } from "./discord/intents.js";
import {
  mergeClientConfig,
  envUpsert,
  envRemoveKey,
  inviteUrl,
  INVITE_CHOICES,
  clientConfigCandidates,
  parseBotsFile,
  suggestBotName,
  uniqueBotName,
  serializeBotsFile,
  addBotToBotsFile,
  type WizardBot,
} from "./wizardLib.js";

// The interactive setup wizard: omnicord init. Walks from a bare Discord
// application to a working client config, validating each step against
// the live API instead of hoping. The pure logic lives in wizardLib.ts;
// this file is the conversation.

const PORTAL = "https://discord.com/developers/applications";

const packageRoot = dirname(
  createRequire(import.meta.url).resolve("../package.json")
);

class Cancelled extends Error {}

// Stdin handling without readline. Readline cannot serve this wizard:
// piped input closes the interface while answers are still buffered, and
// raw-mode token masking would fight readline over the same stream. One
// character-level consumer handles both, so the wizard works typed at a
// terminal and scripted through a pipe.
const ETX = String.fromCharCode(3); // Ctrl+C as a raw-mode character
const DEL = String.fromCharCode(127); // backspace in raw mode

const input: {
  buffer: string;
  lines: string[];
  waiter: ((line: string | undefined) => void) | undefined;
  ended: boolean;
  started: boolean;
  lastWasCR: boolean;
} = {
  buffer: "",
  lines: [],
  waiter: undefined,
  ended: false,
  started: false,
  lastWasCR: false,
};

function deliverLine(line: string | undefined): void {
  if (input.waiter) {
    const w = input.waiter;
    input.waiter = undefined;
    w(line);
  } else if (line !== undefined) {
    input.lines.push(line);
  }
}

function feedInput(text: string): void {
  for (const ch of text) {
    if (ch === ETX) {
      // Ctrl+C in raw mode arrives as a character rather than a signal.
      input.ended = true;
      deliverLine(undefined);
      return;
    }
    if (ch === "\n" && input.lastWasCR) {
      // The tail of a \r\n pair; the \r already delivered the line.
      input.lastWasCR = false;
      continue;
    }
    input.lastWasCR = ch === "\r";
    if (ch === "\r" || ch === "\n") {
      const line = input.buffer;
      input.buffer = "";
      deliverLine(line);
      continue;
    }
    if (ch === DEL || ch === "\b") {
      input.buffer = input.buffer.slice(0, -1);
      continue;
    }
    input.buffer += ch;
  }
}

function startInput(): void {
  if (input.started) return;
  input.started = true;
  process.stdin.on("data", (chunk: Buffer) => feedInput(chunk.toString("utf8")));
  process.stdin.on("end", () => {
    input.ended = true;
    deliverLine(undefined);
  });
  process.stdin.resume();
}

async function nextLine(): Promise<string | undefined> {
  startInput();
  if (input.lines.length > 0) return input.lines.shift();
  if (input.ended) return undefined;
  return new Promise((resolve) => {
    input.waiter = resolve;
  });
}

async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const line = await nextLine();
  if (line === undefined) throw new Cancelled();
  const answer = line.trim();
  if (answer.toLowerCase() === "q") throw new Cancelled();
  return answer;
}

// Token input with no echo: raw mode suppresses terminal echo while the
// same character consumer keeps collecting the line. Piped input reads a
// plain line, so the wizard stays scriptable.
async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(prompt);
  process.stdout.write(prompt);
  startInput();
  process.stdin.setRawMode(true);
  try {
    const line = await nextLine();
    process.stdout.write("\n");
    if (line === undefined) throw new Cancelled();
    return line.trim();
  } finally {
    process.stdin.setRawMode(false);
  }
}

async function discordGet(token: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

interface AppInfo {
  id: string;
  name: string;
  botUsername: string;
  intents: IntentStatus;
}

async function fetchAppInfo(token: string): Promise<AppInfo | undefined> {
  const me = await discordGet(token, "/users/@me");
  if (me.status !== 200) return undefined;
  const app = await discordGet(token, "/applications/@me");
  if (app.status !== 200) return undefined;
  const user = me.json as { id: string; username: string };
  const application = app.json as { id: string; name: string; flags?: number };
  return {
    id: application.id,
    name: application.name,
    botUsername: user.username,
    intents: readIntents(application.flags ?? 0),
  };
}

export async function runWizard(): Promise<void> {
  console.log("");
  console.log(`  ${bold(cyan("Omnicord"))} ${dim("by Orygn")}`);
  console.log(`  ${dim(rule())}`);
  console.log(`  ${dim(`Setup v${VERSION}. Type q at any prompt to quit; nothing is`)}`);
  console.log(`  ${dim("changed until it says so.")}\n`);

  try {
    const cfg = readExistingConfig();
    const hasExisting = cfg.envToken !== undefined || cfg.bots.length > 0;

    if (hasExisting) {
      const total = cfg.bots.length > 0 ? cfg.bots.length : 1;
      const names =
        cfg.bots.length > 0
          ? cfg.bots.map((b) => b.name || "(unnamed)").join(", ")
          : "one bot from .env";
      console.log(
        `  You already have ${total === 1 ? "a bot" : `${total} bots`} set up: ${bold(names)}.\n`
      );
      console.log("  What would you like to do?");
      console.log(`    ${bold("1")}. Add another bot ${dim("(for a different server)")}`);
      console.log(`    ${bold("2")}. Reconfigure from scratch`);
      console.log(`    ${bold("3")}. Quit`);
      const choice = await ask(`  Choose 1-3 ${dim("[1]")}: `);
      if (choice === "3") throw new Cancelled();
      if (choice !== "2") {
        await runAddBot(cfg);
        return;
      }
      // choice 2 falls through to a fresh setup that supersedes the old config.
    }

    await runFreshSetup(cfg);
  } catch (err) {
    if (err instanceof Cancelled) {
      console.log(
        yellow("\nSetup cancelled. Nothing was changed beyond any step already confirmed.")
      );
      return;
    }
    throw err;
  } finally {
    process.stdin.pause();
  }
}

// Where the .env and bots.json live, and what is already configured. Reads
// files only, no Discord calls, so detecting an existing setup never needs a
// token and the smoke test stays offline.
interface ExistingConfig {
  envPath: string;
  botsPath: string;
  envToken: string | undefined;
  bots: WizardBot[];
}

function readExistingConfig(): ExistingConfig {
  const envPath = envFilePath();
  const botsPath = botsFilePath();
  let envToken: string | undefined;
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^\s*DISCORD_TOKEN\s*=\s*(.+?)\s*$/m);
    const value = m ? m[1].trim() : "";
    envToken = value.length > 0 ? value : undefined;
  }
  const bots = existsSync(botsPath)
    ? parseBotsFile(readFileSync(botsPath, "utf8"))
    : [];
  return { envPath, botsPath, envToken, bots };
}

// One bot's setup: token (validated live), intents (rechecked until on), an
// optional short name, and the invite. Shared by every path.
interface CollectedBot {
  token: string;
  app: AppInfo;
  name: string;
}

async function setupBot(opts: {
  heading: string;
  askName: boolean;
  takenNames: string[];
}): Promise<CollectedBot> {
  console.log(bold(cyan(opts.heading)));
  console.log(`  If you do not have this bot yet: open ${underline(PORTAL)}`);
  console.log("  New Application, name it, open the Bot page, Reset Token, copy it.");
  console.log("  Turn on all three Privileged Gateway Intents, and under Installation");
  console.log("  choose Guild Install only (uncheck User Install).\n");

  let token = "";
  let app: AppInfo | undefined;
  while (!app) {
    token = await askHidden(`  Paste the bot token ${dim("(input is hidden)")}: `);
    if (!token) continue;
    process.stdout.write("  Checking with Discord... ");
    app = await fetchAppInfo(token);
    console.log(
      app
        ? `${green("ok.")} This is ${bold(app.botUsername)} (app: ${app.name}).`
        : red("rejected.")
    );
    if (!app) {
      console.log(
        yellow("  Discord did not accept that token. Reset it in the portal and try again.")
      );
    }
  }

  console.log(`\n  ${bold("Privileged gateway intents")}`);
  for (;;) {
    const fresh = await fetchAppInfo(token);
    if (!fresh) {
      console.log(yellow("  Token stopped working; was it reset? Start the wizard again."));
      throw new Cancelled();
    }
    app = fresh;
    const i = app.intents;
    console.log(
      `  Server Members: ${i.members ? green("on") : red(bold("OFF"))}   ` +
        `Message Content: ${i.messageContent ? green("on") : red(bold("OFF"))}   ` +
        `Presence: ${i.presence ? green("on") : yellow("off (optional)")}`
    );
    if (i.members && i.messageContent) break;
    console.log(
      yellow("  Missing intents break member search and message reading.") + " Open the"
    );
    console.log(
      `  Bot page at ${underline(PORTAL)}, toggle them on, save, then press Enter here.`
    );
    await ask(`  Press Enter to re-check ${dim("(or q to quit)")}: `);
  }

  let name = "";
  if (opts.askName) {
    const suggested = suggestBotName(app.botUsername, opts.takenNames);
    const answer = await ask(
      `\n  Short name to tell this bot apart ${dim(`[${suggested}]`)}: `
    );
    name = answer ? uniqueBotName(answer, opts.takenNames) : suggested;
    console.log(`  Named ${bold(name)}.`);
  }

  console.log(`\n  ${bold("Invite the bot to its server")}`);
  console.log("  How much should the bot be allowed to do?");
  INVITE_CHOICES.forEach((c, idx) =>
    console.log(`    ${bold(String(idx + 1))}. ${c.label}`)
  );
  let choice = INVITE_CHOICES[0];
  const pick = await ask(`  Choose 1-${INVITE_CHOICES.length} ${dim("[1]")}: `);
  const pickIndex = Number(pick);
  if (Number.isInteger(pickIndex) && pickIndex >= 1 && pickIndex <= INVITE_CHOICES.length) {
    choice = INVITE_CHOICES[pickIndex - 1];
  }
  console.log(
    `\n  Open this URL, pick the server, authorize:\n  ${underline(cyan(inviteUrl(app.id, choice.permissions)))}\n`
  );
  await ask(`  Press Enter once the bot is in the server ${dim("(or q to quit)")}: `);

  return { token, app, name };
}

// Single-bot only: choose a default server so tools can omit the guild.
async function pickDefaultServer(token: string): Promise<string> {
  const guilds = await discordGet(token, "/users/@me/guilds");
  const guildList = Array.isArray(guilds.json)
    ? (guilds.json as Array<{ id: string; name: string }>)
    : [];
  if (guildList.length === 0) {
    console.log("  The bot is not in any server yet; continuing without a default server.");
    return "";
  }
  console.log("  The bot can see these servers:");
  guildList.forEach((g, idx) => console.log(`    ${idx + 1}. ${g.name} (${g.id})`));
  const sel = await ask(
    `  Use which as the default server? 1-${guildList.length}, or 0 for none ${dim("[1]")}: `
  );
  const selIndex = sel === "" ? 1 : Number(sel);
  if (Number.isInteger(selIndex) && selIndex >= 1 && selIndex <= guildList.length) {
    return guildList[selIndex - 1].id;
  }
  return "";
}

// Register the omnicord server in a client config once, regardless of how many
// bots were set up. Unchanged behavior: adds only the omnicord entry, backs the
// file up first, and never clobbers invalid JSON.
async function registerClient(): Promise<void> {
  const candidates = clientConfigCandidates({
    platform: process.platform,
    homedir: homedir(),
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
    cwd: process.cwd(),
  });
  const present = candidates.filter(
    (c) => c.exists || c.appPresent || c.client === "claude-code"
  );

  console.log("\n  Where should the omnicord server be registered?");
  console.log(dim('  This only adds an "omnicord" entry; everything else in the file'));
  console.log(dim("  is left as-is, and the original is backed up first."));
  present.forEach((c, idx) =>
    console.log(
      `    ${bold(String(idx + 1))}. ${c.label}${c.exists ? "" : dim(" (config file will be created)")}\n       ${dim(c.path)}`
    )
  );
  console.log(
    `    ${bold(String(present.length + 1))}. Just print the config snippet (paste it yourself)`
  );

  const entry = { command: "node", args: [join(packageRoot, "dist", "index.js")] };

  const detected = present.findIndex((c) => c.exists || c.appPresent);
  const defaultChoice = detected >= 0 ? detected + 1 : present.length + 1;
  if (detected >= 0) {
    console.log(
      dim("  If unsure, press Enter: the wizard found this client on your machine.")
    );
  }
  const where = await ask(
    `  Choose 1-${present.length + 1} ${dim(`[${defaultChoice}]`)}: `
  );
  const whereIndex = where === "" ? defaultChoice : Number(where);

  if (Number.isInteger(whereIndex) && whereIndex >= 1 && whereIndex <= present.length) {
    const target = present[whereIndex - 1];
    const before = existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined;
    let merged: string | undefined;
    try {
      merged = mergeClientConfig(before, entry);
    } catch {
      merged = undefined;
    }
    if (merged === undefined) {
      console.log(yellow(`  ${target.path} is not valid JSON, so it was left untouched.`));
      console.log("  Add this to that file's mcpServers by hand:\n");
      console.log(JSON.stringify({ mcpServers: { omnicord: entry } }, null, 2));
    } else {
      if (before !== undefined) {
        const backup = `${target.path}.bak-omnicord-${Date.now()}`;
        copyFileSync(target.path, backup);
        console.log(dim(`  Backed up the existing file to ${backup}`));
      }
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, merged);
      console.log(`  ${green("Wrote omnicord into")} ${target.path}`);
    }
  } else {
    console.log("\n  Add this to your client's MCP config:\n");
    console.log(JSON.stringify({ mcpServers: { omnicord: entry } }, null, 2));
  }
}

function printRestartSteps(): void {
  console.log(`\n${bold("Two steps left:")}`);
  console.log(`  1. ${bold("Fully restart your AI client")}: quit it from the system tray,`);
  console.log("     not just the window. New tools only load on a full restart.");
  console.log(`  2. In a fresh chat, ask: ${cyan('"run a setup check on my Discord bot"')}`);
  console.log("");
}

// A single bot supersedes any prior bots.json, so remove it: the one .env
// token must not merge with stale multi-bot entries.
function writeEnvSingle(
  cfg: ExistingConfig,
  token: string,
  defaultGuild: string
): void {
  mkdirSync(dirname(cfg.envPath), { recursive: true });
  const before = existsSync(cfg.envPath) ? readFileSync(cfg.envPath, "utf8") : "";
  let text = envUpsert(before, "DISCORD_TOKEN", token);
  if (defaultGuild) text = envUpsert(text, "OMNICORD_GUILD", defaultGuild);
  writeFileSync(cfg.envPath, text);
  console.log(`  ${green("Token saved")} to ${cfg.envPath}`);
  console.log(
    `  ${dim(
      IS_INSTALLED
        ? "(stays on this machine; survives npm cache cleans and upgrades)"
        : "(gitignored, stays on this machine)"
    )}`
  );
  if (existsSync(cfg.botsPath)) {
    rmSync(cfg.botsPath);
    console.log(dim("  Removed the previous bots.json (reconfigured to a single bot)."));
  }
}

// Multiple bots go to bots.json. A leftover single-bot token in .env is cleared
// so it does not load as an extra bot.
function writeBotsMulti(cfg: ExistingConfig, bots: WizardBot[]): void {
  mkdirSync(dirname(cfg.botsPath), { recursive: true });
  writeFileSync(cfg.botsPath, serializeBotsFile(bots));
  console.log(`  ${green("Bots saved")} to ${cfg.botsPath}`);
  console.log(
    `  ${dim(
      IS_INSTALLED
        ? "(stays on this machine; survives npm cache cleans and upgrades)"
        : "(gitignored, stays on this machine)"
    )}`
  );
  if (existsSync(cfg.envPath)) {
    const before = readFileSync(cfg.envPath, "utf8");
    if (/^\s*DISCORD_TOKEN\s*=\s*\S/m.test(before)) {
      const after = envRemoveKey(before, "DISCORD_TOKEN");
      if (after.trim().length === 0) rmSync(cfg.envPath);
      else writeFileSync(cfg.envPath, after);
      console.log(dim("  Cleared the previous single-bot token from .env."));
    }
  }
}

function printBotList(bots: WizardBot[]): void {
  for (const b of bots) {
    console.log(`    ${bold(b.name)}${b.default ? dim(" (default)") : ""}`);
  }
  console.log(dim("  Omnicord routes each server to the bot that is in it."));
}

// First-time setup, or a from-scratch reconfigure. Asks how many bots and
// branches: one bot to .env (unchanged), several to bots.json.
async function runFreshSetup(cfg: ExistingConfig): Promise<void> {
  console.log(bold(cyan("How many bots do you want to set up?")));
  console.log(dim("  Most people starting out use 1. If you run several servers each with"));
  console.log(dim("  their own bot, set them all up now; you can always add more later."));
  const answer = await ask(`  How many? ${dim("[1]")}: `);
  const parsed = answer === "" ? 1 : Number(answer);
  const count = Number.isInteger(parsed) && parsed >= 1 && parsed <= 25 ? parsed : 1;

  if (count === 1) {
    console.log("");
    const bot = await setupBot({ heading: "Set up your bot", askName: false, takenNames: [] });
    console.log("");
    const defaultGuild = await pickDefaultServer(bot.token);
    console.log(`\n${bold(cyan("Save configuration"))}`);
    writeEnvSingle(cfg, bot.token, defaultGuild);
    await registerClient();
    console.log(`\n${bold(green("Setup complete."))}`);
    console.log(`  Bot: ${bold(bot.app.botUsername)} (app: ${bot.app.name})`);
    console.log(
      defaultGuild
        ? `  Default server: ${defaultGuild}`
        : "  Default server: none (pass guild per tool call or re-run init)"
    );
    printRestartSteps();
    return;
  }

  const bots: WizardBot[] = [];
  for (let i = 0; i < count; i += 1) {
    console.log("");
    const bot = await setupBot({
      heading: `Bot ${i + 1} of ${count}`,
      askName: true,
      takenNames: bots.map((b) => b.name),
    });
    bots.push({ name: bot.name, token: bot.token, default: i === 0 });
  }
  console.log(`\n${bold(cyan("Save configuration"))}`);
  writeBotsMulti(cfg, bots);
  await registerClient();
  console.log(`\n${bold(green("Setup complete."))}`);
  console.log(`  ${bots.length} bots configured:`);
  printBotList(parseBotsFile(serializeBotsFile(bots)));
  printRestartSteps();
}

// Add one bot to an existing setup. The client is already registered, so this
// only collects the bot and writes bots.json, folding a bare .env bot in first
// (named) so every bot lives in one place.
async function runAddBot(cfg: ExistingConfig): Promise<void> {
  const taken = cfg.bots.map((b) => b.name).filter(Boolean);
  console.log("");
  const bot = await setupBot({ heading: "Add a bot", askName: true, takenNames: taken });

  console.log(`\n${bold(cyan("Save configuration"))}`);
  mkdirSync(dirname(cfg.botsPath), { recursive: true });
  let content = existsSync(cfg.botsPath) ? readFileSync(cfg.botsPath, "utf8") : undefined;

  if (cfg.bots.length === 0 && cfg.envToken) {
    let existingName = "main";
    const info = await fetchAppInfo(cfg.envToken);
    if (info) existingName = suggestBotName(info.botUsername, [bot.name]);
    content = addBotToBotsFile(content, { name: existingName, token: cfg.envToken });
    console.log(dim(`  Kept your existing bot as ${bold(existingName)} (default).`));
  }

  content = addBotToBotsFile(content, { name: bot.name, token: bot.token });
  writeFileSync(cfg.botsPath, content);
  console.log(`  ${green("Bots saved")} to ${cfg.botsPath}`);

  console.log(`\n${bold(green("Bot added."))}`);
  const finalBots = parseBotsFile(content);
  console.log(`  ${finalBots.length} bots configured:`);
  printBotList(finalBots);
  console.log(
    `\n  ${bold("Fully restart your AI client")} for the new bot to take effect.`
  );
  console.log("");
}
