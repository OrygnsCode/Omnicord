// Calls one Omnicord tool from the command line. Dev utility.
//
// Usage: node scripts/call-tool.mjs <tool_name> '<json_args>'
// Example: node scripts/call-tool.mjs list_channels '{}'

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [toolName, rawArgs] = process.argv.slice(2);
if (!toolName) {
  console.error("Usage: node scripts/call-tool.mjs <tool_name> '<json_args>'");
  process.exit(1);
}
const args = rawArgs ? JSON.parse(rawArgs) : {};

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
    }, 30000);
  });
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "omnicord-call-tool", version: "0.0.1" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
);

const res = await request("tools/call", { name: toolName, arguments: args });
const text = res.result?.content?.[0]?.text ?? "{}";
if (res.result?.isError) console.log("[error]");
console.log(text);
child.kill();
process.exit(res.result?.isError ? 1 : 0);
