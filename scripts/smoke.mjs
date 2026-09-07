// Protocol smoke test. Spawns the built server over stdio with no Discord
// token and drives a minimal MCP session: initialize, list tools, call
// run_setup_check. Passing means the transport, registration, and envelope
// plumbing all work before any credentials enter the picture.
//
// Run with: npm run smoke

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");

// Pin the token to an empty string rather than deleting it. The server
// falls back to the .env at the package root, and dotenv never overrides
// a variable that already exists, even an empty one. An empty value reads
// as absent in config, which is exactly the no-token state this test needs.
// The blueprint store gets its own temp directory so smoke runs never
// touch the real one.
const env = { ...process.env };
env.DISCORD_TOKEN = "";
env.OMNICORD_GUILD = "";
env.OMNICORD_DATA_DIR = join(tmpdir(), `omnicord-smoke-${Date.now()}`);

const child = spawn(process.execPath, [entry], {
  cwd: tmpdir(),
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      failNow(`Non-JSON line on stdout: ${line.slice(0, 200)}`);
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

child.stderr.on("data", () => {
  // Logs are expected on stderr. Ignored.
});

function request(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${method}`));
      }
    }, 10000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function assert(condition, label) {
  if (!condition) failNow(`Assertion failed: ${label}`);
  console.log(`ok: ${label}`);
}

function failNow(message) {
  console.error(`SMOKE FAIL: ${message}`);
  child.kill();
  process.exit(1);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "omnicord-smoke", version: "0.0.1" },
  });
  assert(init.result?.serverInfo?.name === "omnicord", "server identifies as omnicord");
  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  assert(names.includes("get_bot_info"), "get_bot_info is registered");
  assert(names.includes("run_setup_check"), "run_setup_check is registered");
  assert(names.includes("send_message"), "send_message is registered");
  assert(names.includes("forward_message"), "forward_message is registered");
  assert(names.includes("set_voice_channel_status"), "set_voice_channel_status is registered");
  assert(names.includes("delete_message"), "delete_message is registered");
  assert(names.includes("plan_server_build"), "plan_server_build is registered");
  assert(names.includes("execute_build_plan"), "execute_build_plan is registered");
  assert(names.includes("delete_channel"), "delete_channel is registered");
  assert(names.includes("pin_message"), "pin_message is registered");
  assert(names.includes("ban_member"), "ban_member is registered");
  assert(names.includes("get_audit_log"), "get_audit_log is registered");
  assert(names.includes("set_incident_actions"), "set_incident_actions is registered");
  assert(names.includes("add_reactions"), "add_reactions is registered");
  assert(names.includes("create_poll"), "create_poll is registered");
  assert(names.includes("create_invite"), "create_invite is registered");
  assert(names.includes("create_webhook"), "create_webhook is registered");
  assert(names.includes("create_emoji"), "create_emoji is registered");
  assert(names.includes("create_event"), "create_event is registered");
  assert(names.includes("subscribe_events"), "subscribe_events is registered");
  assert(names.includes("get_recent_events"), "get_recent_events is registered");
  assert(names.includes("create_thread"), "create_thread is registered");
  assert(names.includes("create_forum_post"), "create_forum_post is registered");
  assert(names.includes("create_automod_rule"), "create_automod_rule is registered");
  assert(names.includes("update_server"), "update_server is registered");
  assert(names.includes("prune_members"), "prune_members is registered");
  assert(names.includes("set_bot_presence"), "set_bot_presence is registered");
  assert(names.includes("update_onboarding"), "update_onboarding is registered");
  assert(names.includes("create_sticker"), "create_sticker is registered");

  // The schema, not just the name: a compiler with no parameter wired to it
  // passes every unit test and is unreachable from a client.
  const byName = new Map((tools.result?.tools ?? []).map((t) => [t.name, t]));
  const props = (n) => Object.keys(byName.get(n)?.inputSchema?.properties ?? {});
  assert(props("send_message").includes("components"), "send_message exposes components");
  assert(props("edit_message").includes("components"), "edit_message exposes components");
  assert(!byName.get("send_message").inputSchema.required?.includes("content"),
    "send_message content is optional now that components can replace it");
  for (const p of ["private_to", "read_only", "posting_roles"]) {
    assert(props("create_channel").includes(p), `create_channel exposes ${p}`);
  }
  const block = byName.get("send_message").inputSchema.properties.components.items;
  assert(block.properties.type.enum.includes("container"), "a component block can be a container");
  assert(!block.properties.components.items.properties.type.enum.includes("container"),
    "a nested component block cannot be a container");
  assert(names.includes("create_soundboard_sound"), "create_soundboard_sound is registered");

  // Without a token the gateway is off; subscribing must explain that
  // instead of pretending events will arrive.
  const deadSub = await request("tools/call", {
    name: "subscribe_events",
    arguments: { types: ["message_created"] },
  });
  assert(deadSub.result?.isError === true, "subscribe without gateway fails gracefully");
  assert(
    (deadSub.result?.content?.[0]?.text ?? "").includes("gateway"),
    "subscribe failure explains the gateway state"
  );
  const delMeta = (tools.result?.tools ?? []).find((t) => t.name === "delete_message");
  assert(delMeta?.annotations?.destructiveHint === true, "delete_message carries destructiveHint");

  const check = await request("tools/call", {
    name: "run_setup_check",
    arguments: {},
  });
  const text = check.result?.content?.[0]?.text ?? "";
  assert(check.result?.isError === true, "setup check reports failure without a token");
  assert(text.includes("DISCORD_TOKEN"), "failure message names DISCORD_TOKEN");

  const envelope = JSON.parse(text);
  assert(typeof envelope.summary === "string", "envelope has a summary");
  assert(Array.isArray(envelope.data?.checks), "envelope data carries the checks list");

  // The blueprint store works without a Discord token: a full save,
  // read, and gated delete lifecycle, against the temp data directory.
  assert(names.includes("save_blueprint"), "save_blueprint is registered");
  assert(names.includes("diff_blueprint"), "diff_blueprint is registered");
  for (const t of [
    "send_dm", "bulk_delete_messages", "schedule_message", "get_message",
    "update_member", "remove_role", "list_voice_members", "get_member_permissions",
    "set_channel_permissions", "lock_channel", "explain_permissions",
    "clone_channel", "reorder_roles", "bulk_update_roles", "start_stage",
    "get_rate_limit_status", "list_servers", "list_members",
  ]) {
    assert(names.includes(t), `${t} is registered`);
  }
  for (const t of [
    "list_app_commands", "register_app_command", "update_app_command", "delete_app_command",
  ]) {
    assert(names.includes(t), `${t} is registered`);
  }
  const delCmdMeta = (tools.result?.tools ?? []).find((t) => t.name === "delete_app_command");
  assert(delCmdMeta?.annotations?.destructiveHint === true, "delete_app_command carries destructiveHint");
  const listCmdMeta = (tools.result?.tools ?? []).find((t) => t.name === "list_app_commands");
  assert(listCmdMeta?.annotations?.readOnlyHint === true, "list_app_commands is read only");

  assert(names.length >= 155, `tool count is at least 155 (got ${names.length})`);

  // The toolset map is only useful if it matches the tools that actually get
  // registered. The unit suite proves the map is internally consistent; this
  // proves it describes this server, so a tool added without a group, or a
  // group naming a tool that was renamed, fails here.
  {
    const { CORE_TOOLS, TOOLSETS, TOOLSET_NAMES } = await import("../dist/toolsets.js");
    const mapped = new Set(CORE_TOOLS);
    for (const g of TOOLSET_NAMES) for (const n of TOOLSETS[g]) mapped.add(n);
    const orphans = names.filter((n) => !mapped.has(n));
    const phantoms = [...mapped].filter((n) => !names.includes(n));
    assert(orphans.length === 0, `every registered tool belongs to a toolset${orphans.length ? ` (orphans: ${orphans.join(", ")})` : ""}`);
    assert(phantoms.length === 0, `no toolset names a tool that is not registered${phantoms.length ? ` (missing: ${phantoms.join(", ")})` : ""}`);
    assert(mapped.size === names.length, `the toolset map covers all ${names.length} tools (map has ${mapped.size})`);

    // The catalog describes core in prose in two places and toolsets.md
    // tabulates it. Each states a count, and each has to be the real one, or
    // a reader is told a different always-loaded set than the one they get.
    const coreCount = CORE_TOOLS.length;
    const words = { 14: "Fourteen", 15: "Fifteen", 16: "Sixteen", 13: "Thirteen" };
    const catalog = readFileSync(join(root, "docs", "tool-catalog.md"), "utf8");
    const toolsetsDoc = readFileSync(join(root, "docs", "toolsets.md"), "utf8");
    assert(
      catalog.includes(`The \`core\` group there is ${coreCount} `),
      `catalog section 1.3 states the real core count (${coreCount})`
    );
    assert(
      catalog.includes(`${words[coreCount] ?? coreCount} tools load no matter what`),
      `catalog section 2 states the real core count (${coreCount})`
    );
    assert(
      new RegExp(`^\\| \`core\` \\| ${coreCount} \\|`, "m").test(toolsetsDoc),
      `toolsets.md tabulates the real core count (${coreCount})`
    );
    // Section 2 also promises every core tool is a read. Hold it to that.
    const toolByName = new Map((tools.result?.tools ?? []).map((t) => [t.name, t]));
    const writesInCore = CORE_TOOLS.filter((n) => toolByName.get(n)?.annotations?.readOnlyHint !== true);
    assert(writesInCore.length === 0, `every core tool is read-only${writesInCore.length ? ` (not: ${writesInCore.join(", ")})` : ""}`);
  }

  async function callTool(name, args) {
    const res = await request("tools/call", { name, arguments: args });
    const envelope = JSON.parse(res.result?.content?.[0]?.text ?? "{}");
    envelope.isError = res.result?.isError === true;
    return envelope;
  }

  const saved = await callTool("save_blueprint", {
    name: "smoke-blueprint",
    blueprint: { roles: [{ name: "Smoke Role", preset: "member" }] },
  });
  assert(typeof saved.data?.id === "string", "blueprint saves without a token");

  const dupe = await callTool("save_blueprint", {
    name: "smoke-blueprint",
    blueprint: {},
  });
  assert(dupe.isError === true, "duplicate blueprint names are refused");

  const listed = await callTool("list_blueprints", {});
  assert(
    (listed.data?.blueprints ?? []).some((b) => b.name === "smoke-blueprint"),
    "saved blueprint shows in the list"
  );

  const fetched = await callTool("get_blueprint", { blueprint: "smoke-blueprint" });
  assert(
    fetched.data?.blueprint?.roles?.[0]?.name === "Smoke Role",
    "blueprint fetches by name with its content"
  );

  const gateResp = await callTool("delete_blueprint", { blueprint: "smoke-blueprint" });
  assert(typeof gateResp.data?.confirm_token === "string", "blueprint delete is gated");
  const deleted = await callTool("delete_blueprint", {
    blueprint: "smoke-blueprint",
    confirm_token: gateResp.data.confirm_token,
  });
  assert(deleted.data?.deleted === true, "gated blueprint delete works");

  const emptied = await callTool("list_blueprints", {});
  assert((emptied.data?.blueprints ?? []).length === 0, "store is empty after delete");

  // The init wizard must exit cleanly on q without touching anything.
  const wizard = (await import("node:child_process")).spawn(
    process.execPath,
    [entry, "init"],
    { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] }
  );
  let wizardOut = "";
  wizard.stdout.on("data", (d) => (wizardOut += d.toString()));
  wizard.stdin.write("q\n");
  const wizardCode = await new Promise((resolve) => {
    wizard.on("exit", resolve);
    setTimeout(() => {
      wizard.kill();
      resolve(-1);
    }, 8000);
  });
  assert(wizardCode === 0, "init wizard exits cleanly on q");
  assert(wizardOut.includes("cancelled"), "init wizard announces cancellation");

  console.log("smoke: all assertions passed");
  child.kill();
  process.exit(0);
} catch (err) {
  failNow(err.message);
}
