import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { VERSION } from "./config.js";
import { envFilePath, IS_INSTALLED } from "./home.js";
import { bold, cyan, dim, green, red, rule, underline, yellow } from "./term.js";
import { readIntents, type IntentStatus } from "./discord/intents.js";
import {
  mergeClientConfig,
  envUpsert,
  inviteUrl,
  INVITE_CHOICES,
  clientConfigCandidates,
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
    // Step 1: the Discord application.
    console.log(bold(cyan("Step 1 of 5: Discord application")));
    console.log(`  If you do not have a bot yet: open ${underline(PORTAL)}`);
    console.log("  New Application, name it, open the Bot page, Reset Token, copy it.");
    console.log("  While you are there, turn on all three Privileged Gateway Intents.\n");

    // Step 2: token, validated live until it works.
    let token = "";
    let app: AppInfo | undefined;
    while (!app) {
      token = await askHidden(
        `${bold(cyan("Step 2 of 5:"))} paste the bot token ${dim("(input is hidden)")}: `
      );
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

    // Step 3: intents, rechecked until enabled.
    console.log(`\n${bold(cyan("Step 3 of 5: privileged gateway intents"))}`);
    for (;;) {
      const fresh = await fetchAppInfo(token);
      if (!fresh) {
        console.log(yellow("  Token stopped working; was it reset? Start the wizard again."));
        return;
      }
      const i = fresh.intents;
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

    // Step 4: invite the bot and pick a default server.
    console.log(`\n${bold(cyan("Step 4 of 5: invite the bot to a server"))}`);
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
      `\n  Open this URL, pick your server, authorize:\n  ${underline(cyan(inviteUrl(app.id, choice.permissions)))}\n`
    );
    await ask(`  Press Enter once the bot is in the server ${dim("(or q to quit)")}: `);

    let defaultGuild = "";
    const guilds = await discordGet(token, "/users/@me/guilds");
    const guildList = Array.isArray(guilds.json)
      ? (guilds.json as Array<{ id: string; name: string }>)
      : [];
    if (guildList.length === 0) {
      console.log("  The bot is not in any server yet. You can re-run the wizard later;");
      console.log("  continuing without a default server.");
    } else {
      console.log("  The bot can see these servers:");
      guildList.forEach((g, idx) => console.log(`    ${idx + 1}. ${g.name} (${g.id})`));
      const sel = await ask(
        `  Use which as the default server? 1-${guildList.length}, or 0 for none ${dim("[1]")}: `
      );
      const selIndex = sel === "" ? 1 : Number(sel);
      if (Number.isInteger(selIndex) && selIndex >= 1 && selIndex <= guildList.length) {
        defaultGuild = guildList[selIndex - 1].id;
      }
    }

    // Step 5: write .env and the client config. Installed copies (npx,
    // global installs) save to ~/.omnicord so the token outlives npm
    // cache cleans and upgrades; source checkouts keep .env at the
    // package root as always. home.ts owns that rule.
    console.log(`\n${bold(cyan("Step 5 of 5: save configuration"))}`);
    const envPath = envFilePath();
    mkdirSync(dirname(envPath), { recursive: true });
    const envBefore = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    let envText = envUpsert(envBefore, "DISCORD_TOKEN", token);
    if (defaultGuild) envText = envUpsert(envText, "OMNICORD_GUILD", defaultGuild);
    writeFileSync(envPath, envText);
    console.log(`  ${green("Token saved")} to ${envPath}`);
    console.log(
      `  ${dim(
        IS_INSTALLED
          ? "(stays on this machine; survives npm cache cleans and upgrades)"
          : "(gitignored, stays on this machine)"
      )}`
    );

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
    console.log(
      dim('  This only adds an "omnicord" entry; everything else in the file')
    );
    console.log(dim("  is left as-is, and the original is backed up first."));
    present.forEach((c, idx) =>
      console.log(
        `    ${bold(String(idx + 1))}. ${c.label}${c.exists ? "" : dim(" (config file will be created)")}\n       ${dim(c.path)}`
      )
    );
    console.log(
      `    ${bold(String(present.length + 1))}. Just print the config snippet (paste it yourself)`
    );

    const entry = {
      command: "node",
      args: [join(packageRoot, "dist", "index.js")],
    };

    // Default to the first detected client: one with an existing config,
    // or failing that one that looks installed. Printing the snippet stays
    // the fallback when nothing was detected, so pressing Enter does the
    // right thing either way.
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
        // The existing file is not valid JSON. Never overwrite it; the
        // user's config is safer untouched than clobbered.
        console.log(
          yellow(`  ${target.path} is not valid JSON, so it was left untouched.`)
        );
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
      console.log(
        JSON.stringify({ mcpServers: { omnicord: entry } }, null, 2)
      );
    }

    console.log(`\n${bold(green("Setup complete."))}`);
    console.log(`  Bot: ${bold(app.botUsername)} (app: ${app.name})`);
    console.log("  Intents: members on, message content on");
    console.log(
      defaultGuild
        ? `  Default server: ${defaultGuild}`
        : "  Default server: none (pass guild per tool call or re-run init)"
    );
    console.log(`\n${bold("Two steps left:")}`);
    console.log(
      `  1. ${bold("Fully restart your AI client")}: quit it from the system tray,`
    );
    console.log("     not just the window. New tools only load on a full restart.");
    console.log(
      `  2. In a fresh chat, ask: ${cyan('"run a setup check on my Discord bot"')}`
    );
    console.log("");
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
