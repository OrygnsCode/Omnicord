// Removes everything a run-blueprint.mjs build created, reading the saved
// .demo-build.json report. Channels go first, then categories, then roles.
// Runs with safe mode off because this is a scripted, single-purpose
// cleanup; interactive deletion should keep the confirmation gate.
//
// Usage: node scripts/cleanup-build.mjs

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reportPath = join(root, ".demo-build.json");
const { report } = JSON.parse(readFileSync(reportPath, "utf8"));

const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  cwd: root,
  env: { ...process.env, OMNICORD_SAFE_MODE: "false" },
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let nextId = 1;
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timed out on ${method}`));
      }
    }, 60000);
  });
}

async function callTool(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  const envelope = JSON.parse(res.result?.content?.[0]?.text ?? "{}");
  envelope.isError = res.result?.isError === true;
  return envelope;
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "omnicord-cleanup", version: "0.0.1" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
);

const channels = report.filter((r) => r.action === "create_channel" && r.id);
const categories = report.filter((r) => r.action === "create_category" && r.id);
const roles = report.filter((r) => r.action === "create_role" && r.id);

let failures = 0;
for (const item of [...channels, ...categories]) {
  const res = await callTool("delete_channel", { channel: item.id });
  if (res.isError) {
    failures += 1;
    console.error(`failed: ${item.name}: ${res.summary}`);
  } else {
    console.log(`deleted: ${item.name}`);
  }
}
for (const item of roles) {
  const res = await callTool("delete_role", { role: item.id });
  if (res.isError) {
    failures += 1;
    console.error(`failed: ${item.name}: ${res.summary}`);
  } else {
    console.log(`deleted role: ${item.name}`);
  }
}

if (failures === 0) {
  unlinkSync(reportPath);
  console.log(`\ncleanup complete: ${channels.length + categories.length} channels, ${roles.length} roles removed`);
} else {
  console.error(`\ncleanup finished with ${failures} failure(s); report kept`);
}
child.kill();
process.exit(failures === 0 ? 0 : 1);
