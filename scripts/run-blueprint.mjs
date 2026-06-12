// Stages and executes a blueprint file against the configured server, with
// no cleanup. A dev utility for demos and manual testing.
//
// Usage: node scripts/run-blueprint.mjs examples/dark-fantasy.json

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const blueprintPath = process.argv[2];
if (!blueprintPath) {
  console.error("Usage: node scripts/run-blueprint.mjs <blueprint.json>");
  process.exit(1);
}
const blueprint = JSON.parse(readFileSync(blueprintPath, "utf8"));

const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  cwd: root,
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
  clientInfo: { name: "omnicord-blueprint-runner", version: "0.0.1" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
);

const plan = await callTool("plan_server_build", { blueprint });
console.log(`\nplan: ${plan.summary}`);
if (plan.isError) {
  for (const e of plan.data?.errors ?? []) console.error(`  error: ${e}`);
  child.kill();
  process.exit(1);
}
for (const step of plan.data.steps) {
  const note = step.exists ? " (exists, reuse)" : "";
  console.log(`  ${step.order}. ${step.action} ${step.name}${note}`);
}

const built = await callTool("execute_build_plan", { plan_id: plan.data.plan_id });
console.log(`\nbuild: ${built.summary}`);
if (built.isError) {
  child.kill();
  process.exit(1);
}
for (const r of built.data.report) {
  console.log(`  ${r.status}: ${r.action} ${r.name}${r.id ? ` (${r.id})` : ""}`);
}

writeFileSync(
  join(root, ".demo-build.json"),
  JSON.stringify({ when: new Date().toISOString(), report: built.data.report }, null, 2)
);
console.log("\nreport saved to .demo-build.json for later cleanup");
child.kill();
process.exit(0);
