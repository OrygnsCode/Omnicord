// Streamable HTTP transport smoke test. No Discord token needed; this
// exercises the transport, session management, and every security gate.
//
// Run with: node scripts/smoke-http.mjs

import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

function startServer(extraEnv = {}) {
  const env = { ...process.env, DISCORD_TOKEN: "", OMNICORD_GUILD: "", ...extraEnv };
  return spawn(process.execPath, [entry, "--http", "--port", String(PORT)], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function rpc(method, params, id) {
  return { jsonrpc: "2.0", id, method, params };
}

async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json };
}

// Part 1: open loopback mode, full session lifecycle and gates.
{
  const child = startServer();
  check(await waitForHealth(), "http server comes up");

  const health = await (await fetch(`${BASE}/healthz`)).json();
  check(health.name === "omnicord" && health.sessions === 0, "healthz reports identity and zero sessions");

  const noSession = await post(rpc("tools/list", {}, 1));
  check(noSession.status === 400, "non-initialize without session is 400");

  const bogusSession = await post(rpc("tools/list", {}, 2), { "mcp-session-id": "nope" });
  check(bogusSession.status === 404, "unknown session is 404");

  const evil = await post(
    rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "evil", version: "0" } }, 3),
    { Origin: "https://evil.example" }
  );
  check(evil.status === 403, "browser origin is rejected");

  // fetch silently drops a custom Host header (undici treats it as
  // forbidden), so the rebinding probe needs a raw http request to
  // actually send a hostile Host.
  const rebindStatus = await new Promise((resolve, reject) => {
    const body = JSON.stringify(
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } }, 4)
    );
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          Host: "attacker.example",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
  check(rebindStatus === 403, "non-loopback Host header is rejected in open mode");

  const init = await post(
    rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-http", version: "0.0.1" } }, 5)
  );
  check(init.status === 200, "initialize succeeds");
  check(init.json?.result?.serverInfo?.name === "omnicord", "server identifies as omnicord over http");
  const sessionId = init.headers.get("mcp-session-id");
  check(typeof sessionId === "string" && sessionId.length > 0, "initialize returns a session id");

  await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });

  const tools = await post(rpc("tools/list", {}, 6), { "mcp-session-id": sessionId });
  const names = (tools.json?.result?.tools ?? []).map((t) => t.name);
  check(names.includes("get_bot_info"), "tools list over http includes get_bot_info");
  check(names.includes("execute_build_plan"), "tools list over http includes execute_build_plan");

  const call = await post(
    rpc("tools/call", { name: "run_setup_check", arguments: {} }, 7),
    { "mcp-session-id": sessionId }
  );
  const text = call.json?.result?.content?.[0]?.text ?? "";
  check(call.json?.result?.isError === true, "setup check fails gracefully without a token");
  check(text.includes("DISCORD_TOKEN"), "failure names DISCORD_TOKEN over http");

  const healthAfter = await (await fetch(`${BASE}/healthz`)).json();
  check(healthAfter.sessions === 1, "healthz counts the live session");

  const del = await fetch(`${BASE}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
  check(del.status === 200 || del.status === 204, "session DELETE is accepted");

  const afterDelete = await post(rpc("tools/list", {}, 8), { "mcp-session-id": sessionId });
  check(afterDelete.status === 404, "deleted session is gone");

  child.kill();
  await new Promise((r) => setTimeout(r, 300));
}

// Part 2: bearer auth mode.
{
  const child = startServer({ OMNICORD_HTTP_TOKEN: "smoke-secret-token" });
  check(await waitForHealth(), "auth-mode server comes up");

  const initBody = rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-http", version: "0.0.1" } },
    1
  );

  const noAuth = await post(initBody);
  check(noAuth.status === 401, "missing bearer is 401");

  const wrongAuth = await post(initBody, { Authorization: "Bearer wrong" });
  check(wrongAuth.status === 401, "wrong bearer is 401");

  const goodAuth = await post(initBody, { Authorization: "Bearer smoke-secret-token" });
  check(goodAuth.status === 200, "correct bearer initializes");

  const health = await fetch(`${BASE}/healthz`);
  check(health.ok, "healthz stays public in auth mode");

  child.kill();
  await new Promise((r) => setTimeout(r, 300));
}

// Part 3: refusing to expose the bot without auth.
{
  const child = spawn(
    process.execPath,
    [entry, "--http", "--port", String(PORT), "--host", "0.0.0.0"],
    { cwd: root, env: { ...process.env, DISCORD_TOKEN: "", OMNICORD_HTTP_TOKEN: "" }, stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 5000);
  });
  check(code === 1, "public bind without a token refuses to start");
  check(stderr.includes("OMNICORD_HTTP_TOKEN"), "refusal message names the fix");
}

if (failures > 0) {
  console.error(`\nsmoke-http: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-http: all passed");
