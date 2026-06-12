// Docker image smoke test. Builds the image, verifies that a container
// without an HTTP token refuses to start, then runs one with a token and
// checks health, auth, and an MCP initialize through the published port.
//
// Needs a running Docker daemon. Run with: node scripts/smoke-docker.mjs

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const IMAGE = "omnicord:smoke";
const NAME = "omnicord-smoke";
const PORT = 18414;
const TOKEN = "docker-smoke-secret";

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

async function docker(...args) {
  return exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
}

async function cleanup() {
  await docker("rm", "-f", NAME).catch(() => undefined);
}

try {
  await docker("info");
} catch {
  console.error("Docker daemon is not running; skipping the image smoke test.");
  process.exit(2);
}

console.log("building image (first run takes a minute)...");
const build = spawn("docker", ["build", "-t", IMAGE, "."], { stdio: ["ignore", "ignore", "pipe"] });
let buildErr = "";
build.stderr.on("data", (d) => (buildErr += d.toString()));
const buildCode = await new Promise((r) => build.on("exit", r));
if (buildCode !== 0) {
  console.error(buildErr.slice(-2000));
  console.error("FAIL: docker build");
  process.exit(1);
}
check(true, "image builds");

await cleanup();

// A container with no HTTP token must refuse to start, fast and loud.
const refusal = await docker(
  "run", "--rm", "--name", `${NAME}-refusal`,
  "-e", "DISCORD_TOKEN=",
  IMAGE
).then(
  () => ({ code: 0, stderr: "" }),
  (err) => ({ code: err.code ?? 1, stderr: String(err.stderr ?? "") })
);
check(refusal.code !== 0, "tokenless container refuses to start");
check(
  refusal.stderr.includes("OMNICORD_HTTP_TOKEN"),
  "refusal message names the fix"
);

// The real thing: token set, port published.
await docker(
  "run", "-d", "--name", NAME,
  "-p", `${PORT}:3414`,
  "-e", "DISCORD_TOKEN=",
  "-e", `OMNICORD_HTTP_TOKEN=${TOKEN}`,
  IMAGE
);

const BASE = `http://127.0.0.1:${PORT}`;
let healthy = false;
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch(`${BASE}/healthz`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    // container still starting
  }
  await new Promise((r) => setTimeout(r, 250));
}
check(healthy, "containerized server answers health checks");

const health = healthy ? await (await fetch(`${BASE}/healthz`)).json() : {};
check(health.name === "omnicord", "health reports omnicord");

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-docker", version: "0.1.0" },
  },
});
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const noAuth = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: initBody });
check(noAuth.status === 401, "container requires bearer auth");

const withAuth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { ...headers, Authorization: `Bearer ${TOKEN}` },
  body: initBody,
});
const initJson = await withAuth.json().catch(() => ({}));
check(withAuth.status === 200, "authorized initialize succeeds in the container");
check(
  initJson?.result?.serverInfo?.name === "omnicord",
  "container identifies as omnicord over mcp"
);

const whoami = await docker("exec", NAME, "whoami");
check(whoami.stdout.trim() === "omnicord", "container runs as a non-root user");

await cleanup();

if (failures > 0) {
  console.error(`\nsmoke-docker: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-docker: all passed");
