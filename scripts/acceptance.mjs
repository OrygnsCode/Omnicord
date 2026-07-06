// Live acceptance test. Unlike the smoke test, this one needs a real
// DISCORD_TOKEN (from .env at the package root) and talks to the actual
// Discord API. It drives the server over stdio exactly like an MCP client
// would and prints the envelope summaries so a human can eyeball them.
//
// Run with: node scripts/acceptance.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Test assets are generated from raw bytes and served over loopback so
// the sticker and soundboard tools fetch real URLs without depending on
// anything external having the right size or format.

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crc32.table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// A solid-color truecolor PNG at exactly the sticker size.
function makePng(size, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A short silent MPEG-1 Layer III stream: valid frame headers with
// zeroed payloads, which decoders render as silence. About half a second.
function makeSilentMp3() {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: 20 }, () => frame));
}

const ASSET_PORT = 38917;
const stickerPng = makePng(320, 60, 120, 200);
const soundMp3 = makeSilentMp3();
const assetServer = createServer((req, res) => {
  if (req.url === "/sticker.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(stickerPng);
  } else if (req.url === "/sound.mp3") {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(soundMp3);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => assetServer.listen(ASSET_PORT, "127.0.0.1", resolve));

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");

const child = spawn(process.execPath, [entry], {
  cwd: root,
  // A fast scheduler tick so the schedule_message test fires within the
  // run instead of waiting out the production half-minute interval.
  env: { ...process.env, OMNICORD_SCHEDULER_TICK_MS: "1500" },
  stdio: ["pipe", "pipe", "inherit"],
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
    // Generous timeout: the rate limiter queues politely when Discord
    // imposes a bucket wait, and heavy write sequences legitimately sit
    // in that queue for tens of seconds.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }
    }, 60000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let failed = false;

// Calls a tool and returns the envelope with isError attached, without
// treating an error as a test failure. For steps where an error is the
// expected outcome.
async function callToolRaw(name, args = {}) {
  const res = await request("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? "{}";
  const envelope = JSON.parse(text);
  envelope.isError = res.result?.isError === true;
  console.log(`\n[${envelope.isError ? "error" : "ok"}] ${name}`);
  console.log(`  ${envelope.summary}`);
  return envelope;
}

async function callTool(name, args = {}) {
  const envelope = await callToolRaw(name, args);
  if (envelope.isError) failed = true;
  for (const w of envelope.warnings ?? []) {
    console.log(`  warning: ${w}`);
  }
  return envelope;
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "omnicord-acceptance", version: "0.0.1" },
  });
  notify("notifications/initialized", {});

  const info = await callTool("get_bot_info");
  const guilds = info.data?.guilds?.list ?? [];
  if (guilds.length > 0) {
    console.log("  guilds:");
    for (const g of guilds) console.log(`    ${g.name} (${g.id})`);
  }

  const check = await callTool("run_setup_check");
  for (const c of check.data?.checks ?? []) {
    const mark = c.status === "pass" ? "+" : c.status === "warn" ? "!" : "x";
    console.log(`  [${mark}] ${c.check}: ${c.detail}`);
    if (c.fix) console.log(`      fix: ${c.fix}`);
  }

  // Phase 1 read tools, all against the default guild from .env.
  await callTool("get_server_overview");
  await callTool("list_channels");
  await callTool("list_roles");

  const found = await callTool("find", { query: "general" });
  if (!found.data?.match && !(found.data?.candidates?.length >= 0)) {
    failed = true;
    console.error("  find returned neither match nor candidates");
  }

  await callTool("search_members", { query: "Omnicord" });
  await callTool("get_member", { user: "Omnicord" });
  await callTool("read_messages", { channel: "general" });
  await callTool("search_messages", { channel: "general", query: "omnicord" });

  // Phase 2: writes, the confirmation gate, and cleanup. The flow leaves
  // the server exactly as it found it.

  function expect(condition, label) {
    if (condition) {
      console.log(`  expect ok: ${label}`);
    } else {
      failed = true;
      console.error(`  EXPECT FAIL: ${label}`);
    }
  }

  // Runs a destructive tool through its full gate: first call returns the
  // preview and token, second call executes with it.
  async function deleteViaTool(tool, refKey, refValue) {
    const gate = await callTool(tool, { [refKey]: refValue });
    if (gate.data?.confirm_token) {
      return callTool(tool, {
        [refKey]: refValue,
        confirm_token: gate.data.confirm_token,
      });
    }
    return gate;
  }

  const stamp = `omnicord acceptance ${Date.now()}`;

  const dryMsg = await callTool("send_message", {
    channel: "general",
    content: "never sent",
    dry_run: true,
  });
  expect(dryMsg.data?.executed === false, "send_message dry_run sends nothing");

  const sent = await callTool("send_message", {
    channel: "general",
    content: stamp,
  });
  expect(typeof sent.data?.id === "string", "send_message returns a message id");
  expect(typeof sent.data?.jump_link === "string", "send_message returns a jump link");

  const reply = await callTool("send_message", {
    channel: "general",
    content: "reply for the acceptance run",
    reply_to: sent.data.id,
  });
  expect(typeof reply.data?.id === "string", "reply sends");

  // Native search hits Discord's index, which lags a moment behind a just-sent
  // message, so assert the result shape and the filter paths rather than that
  // this exact message is already searchable.
  const searchShape = await callTool("search_messages", { query: "omnicord" });
  expect(
    typeof searchShape.data?.total_results === "number" &&
      Array.isArray(searchShape.data?.matches),
    "search returns the native index result shape"
  );

  const searchByAuthor = await callTool("search_messages", { author: "Omnicord" });
  expect(
    typeof searchByAuthor.data?.total_results === "number",
    "search accepts an author filter"
  );

  const searchByHas = await callTool("search_messages", { has: "poll" });
  expect(Array.isArray(searchByHas.data?.matches), "search accepts a has filter");

  const searchNoFilter = await callToolRaw("search_messages", {});
  expect(searchNoFilter.isError === true, "search with no filter is rejected");

  const newChannel = await callTool("create_channel", {
    name: "omnitest-temp",
    topic: "Omnicord acceptance area, safe to delete",
  });
  expect(typeof newChannel.data?.id === "string", "create_channel returns an id");

  const inNew = await callTool("send_message", {
    channel: "omnitest-temp",
    content: "hello from the acceptance run",
  });
  expect(typeof inNew.data?.id === "string", "fresh channel accepts messages");

  const newRole = await callTool("create_role", {
    name: "omnitest-role",
    preset: "member",
    color: "#00b0f4",
  });
  expect(typeof newRole.data?.id === "string", "create_role returns an id");
  expect(
    !(newRole.data?.permissions ?? []).includes("administrator"),
    "member preset does not grant administrator"
  );

  const assigned = await callTool("assign_role", {
    member: "Omnicord",
    role: "omnitest-role",
  });
  expect(assigned.data?.role?.name === "omnitest-role", "role assigned to the bot");

  const again = await callTool("assign_role", {
    member: "Omnicord",
    role: "omnitest-role",
  });
  expect(again.data?.already_assigned === true, "double assignment is a no-op");

  // Confirmation gate, live: no token means preview, bogus token means
  // rejection, real token means deletion.
  const gate = await callTool("delete_message", {
    channel: "general",
    message_id: reply.data.id,
  });
  expect(gate.data?.executed === false, "deletion without token is blocked");
  expect(typeof gate.data?.confirm_token === "string", "preview returns a token");

  const stillThere = await callTool("read_messages", {
    channel: "general",
    limit: 10,
  });
  expect(
    (stillThere.data?.messages ?? []).some((m) => m.id === reply.data.id),
    "message survives the preview"
  );

  const bogus = await callToolRaw("delete_message", {
    channel: "general",
    message_id: reply.data.id,
    confirm_token: "0".repeat(32),
  });
  expect(bogus.isError === true, "bogus token is rejected");

  const realDelete = await callTool("delete_message", {
    channel: "general",
    message_id: reply.data.id,
    confirm_token: gate.data.confirm_token,
  });
  expect(realDelete.data?.deleted === true, "valid token deletes");

  const gateTwo = await callTool("delete_message", {
    channel: "general",
    message_id: sent.data.id,
  });
  const deleteTwo = await callTool("delete_message", {
    channel: "general",
    message_id: sent.data.id,
    confirm_token: gateTwo.data?.confirm_token,
  });
  expect(deleteTwo.data?.deleted === true, "second deletion with its own token");

  const afterCleanup = await callTool("read_messages", {
    channel: "general",
    limit: 10,
  });
  const ids = (afterCleanup.data?.messages ?? []).map((m) => m.id);
  expect(
    !ids.includes(sent.data.id) && !ids.includes(reply.data.id),
    "both acceptance messages are gone"
  );

  // Phase 3a: builder staging. Everything here must change nothing.

  const layouts = await callTool("list_reference_layouts");
  expect((layouts.data?.layouts ?? []).length === 3, "three reference layouts ship");

  const layout = await callTool("get_reference_layout", {
    layout_id: "gaming-community",
  });
  expect(Boolean(layout.data?.blueprint?.categories), "layout carries a blueprint");

  const missingLayout = await callToolRaw("get_reference_layout", {
    layout_id: "does-not-exist",
  });
  expect(missingLayout.isError === true, "unknown layout id is rejected");

  const beforePlan = await callTool("list_channels");
  const beforeCount = (beforePlan.data?.channels ?? []).length;

  const plan = await callTool("plan_server_build", {
    blueprint: {
      theme: "acceptance staging probe",
      roles: [{ name: "omnitest-planned", preset: "member" }],
      categories: [
        {
          name: "omnitest-planned-cat",
          channels: [
            { name: "omnitest-planned-chan", topic: "never created" },
            { name: "Planned Voice", type: "voice" },
          ],
        },
      ],
      channels: [{ name: "general" }],
    },
  });
  expect(typeof plan.data?.plan_id === "string", "plan stages with an id");
  expect(plan.data?.steps?.[0]?.action === "create_role", "plan orders roles first");
  expect(plan.data?.to_create === 4, "plan counts four new items");
  expect(plan.data?.reused === 1, "plan reuses existing general channel");

  const afterPlan = await callTool("list_channels");
  expect(
    (afterPlan.data?.channels ?? []).length === beforeCount,
    "planning created nothing"
  );

  const badPlan = await callToolRaw("plan_server_build", {
    blueprint: {
      channels: [
        { name: "ghost-channel", private_to: ["Nonexistent Role"] },
        { name: "rules", posting_roles: ["Nonexistent Role"] },
      ],
    },
  });
  expect(badPlan.isError === true, "invalid blueprint is rejected");
  expect(
    (badPlan.data?.errors ?? []).length >= 2,
    "all blueprint problems reported at once"
  );

  // Raw REST access for verification and cleanup; delete tools arrive in
  // a later phase.
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: join(root, ".env"), quiet: true });
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.OMNICORD_GUILD;
  const auth = { Authorization: `Bot ${token}` };

  // Phase 3b: execute a real build, verify the overwrites Discord stored,
  // prove idempotent re-runs, then remove everything.

  const execBlueprint = {
    theme: "acceptance build",
    roles: [{ name: "omnitest-exec-role", preset: "member", color: "#ff7f50" }],
    categories: [
      {
        name: "omnitest-private-cat",
        private_to: ["omnitest-exec-role"],
        channels: [{ name: "omnitest-secret", topic: "inherits category privacy" }],
      },
      {
        name: "omnitest-open-cat",
        channels: [
          {
            name: "omnitest-rules",
            read_only: true,
            posting_roles: ["omnitest-exec-role"],
            topic: "read only test",
          },
          { name: "Omnitest Voice", type: "voice" },
        ],
      },
    ],
  };

  const stagedExec = await callTool("plan_server_build", {
    blueprint: execBlueprint,
  });
  expect(stagedExec.data?.to_create === 6, "exec plan stages six new items");

  const badExec = await callToolRaw("execute_build_plan", {
    plan_id: "0".repeat(16),
  });
  expect(badExec.isError === true, "unknown plan_id is rejected");

  const built = await callTool("execute_build_plan", {
    plan_id: stagedExec.data.plan_id,
  });
  expect(built.data?.created === 6, "build creates all six items");
  expect(built.data?.report?.every((r) => r.status !== "failed"), "no step failed");

  const byName = new Map(built.data.report.map((r) => [r.name, r]));
  const secretId = byName.get("omnitest-secret")?.id;
  const rulesId = byName.get("omnitest-rules")?.id;
  const roleStep = byName.get("omnitest-exec-role");

  // Verify what Discord actually stored, not what we sent.
  const secretChan = await (
    await fetch(`https://discord.com/api/v10/channels/${secretId}`, {
      headers: auth,
    })
  ).json();
  const VIEW_BIT = 1n << 10n;
  const everyoneOw = (secretChan.permission_overwrites ?? []).find(
    (o) => o.id === guildId
  );
  const roleOw = (secretChan.permission_overwrites ?? []).find(
    (o) => o.id === roleStep?.id
  );
  expect(
    everyoneOw && (BigInt(everyoneOw.deny) & VIEW_BIT) !== 0n,
    "live secret channel denies everyone view"
  );
  expect(
    roleOw && (BigInt(roleOw.allow) & VIEW_BIT) !== 0n,
    "live secret channel allows the role view"
  );

  const rulesChan = await (
    await fetch(`https://discord.com/api/v10/channels/${rulesId}`, {
      headers: auth,
    })
  ).json();
  const SEND_BIT = 1n << 11n;
  const rulesEveryone = (rulesChan.permission_overwrites ?? []).find(
    (o) => o.id === guildId
  );
  expect(
    rulesEveryone && (BigInt(rulesEveryone.deny) & SEND_BIT) !== 0n,
    "live rules channel denies everyone send"
  );

  // Idempotency: the same blueprint again, inline this time. Everything
  // already exists, so nothing new may be created.
  const rerun = await callTool("execute_build_plan", {
    blueprint: execBlueprint,
  });
  expect(rerun.data?.created === 0, "re-run creates nothing");
  expect(rerun.data?.reused === 6, "re-run reuses all six items");

  // Cleanup via the real gated tools: channels first, categories after,
  // then the role.
  for (const name of [
    "omnitest-secret",
    "omnitest-rules",
    "Omnitest Voice",
    "omnitest-private-cat",
    "omnitest-open-cat",
  ]) {
    const id = byName.get(name)?.id;
    if (!id) continue;
    const res = await deleteViaTool("delete_channel", "channel", id);
    expect(res.data?.deleted === true, `gated delete removed ${name}`);
  }
  const execRoleDel = await deleteViaTool("delete_role", "role", roleStep?.id);
  expect(execRoleDel.data?.deleted === true, "gated delete removed the exec role");

  // Live probe: the planner allows forums on non-community servers based
  // on a June 2026 probe of the real API. This keeps checking that, so a
  // Discord policy change shows up here instead of in a user's build.
  const probe = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/channels`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "omnitest-forum-probe", type: 15 }),
    }
  );
  if (probe.ok) {
    const created = await probe.json();
    expect(true, "forum creation on non-community server still works");
    await fetch(`https://discord.com/api/v10/channels/${created.id}`, {
      method: "DELETE",
      headers: auth,
    });
  } else {
    expect(
      false,
      `forum probe failed (${probe.status}); planner gating needs retuning`
    );
  }
  // Phase 4 batch 1: updates, edits, pins, then gated deletes finish the
  // cleanup that raw REST used to do.
  const chUpdate = await callTool("update_channel", {
    channel: "omnitest-temp",
    topic: "updated by the acceptance run",
    slowmode_seconds: 5,
  });
  expect((chUpdate.data?.changed ?? []).length === 2, "update_channel changes two fields");

  const edited = await callTool("edit_message", {
    channel: "omnitest-temp",
    message_id: inNew.data.id,
    content: "edited by the acceptance run",
  });
  expect(edited.data?.id === inNew.data.id, "edit_message edits the bot's own message");

  const pinned = await callTool("pin_message", {
    channel: "omnitest-temp",
    message_id: inNew.data.id,
  });
  expect(pinned.data?.pinned === true, "message pins");
  const pinsList = await callTool("list_pinned_messages", {
    channel: "omnitest-temp",
  });
  expect(
    (pinsList.data?.pins ?? []).some((p) => p.id === inNew.data.id),
    "pin shows in the pin list"
  );
  const unpinned = await callTool("unpin_message", {
    channel: "omnitest-temp",
    message_id: inNew.data.id,
  });
  expect(unpinned.data?.pinned === false, "message unpins");

  const roleUpdate = await callTool("update_role", {
    role: "omnitest-role",
    color: "#22c55e",
    name: "omnitest-role-renamed",
  });
  expect((roleUpdate.data?.changed ?? []).length === 2, "update_role changes two fields");

  const delCh = await deleteViaTool("delete_channel", "channel", newChannel.data.id);
  expect(delCh.data?.deleted === true, "gated delete_channel removed the test channel");
  const delRoleTool = await deleteViaTool("delete_role", "role", newRole.data.id);
  expect(delRoleTool.data?.deleted === true, "gated delete_role removed the test role");

  // Phase 4 batch 2: moderation. With only the owner and the bot on the
  // test server, the live tests target the protection paths (which must
  // refuse with clear reasons) plus the two read tools. Actual kicks and
  // bans get exercised when a second test account joins.

  const ownerInfo = await callTool("get_server_overview");
  const ownerId = ownerInfo.data?.owner_id;

  const kickOwner = await callToolRaw("kick_member", { member: ownerId });
  expect(
    kickOwner.isError === true && /owner/i.test(kickOwner.summary),
    "kicking the owner is refused with an owner explanation"
  );

  const banOwner = await callToolRaw("ban_member", { user: ownerId, dry_run: true });
  expect(
    banOwner.isError === true && /owner/i.test(banOwner.summary),
    "banning the owner is refused before the gate"
  );

  const timeoutSelf = await callToolRaw("timeout_member", {
    member: "Omnicord",
    duration_minutes: 5,
  });
  expect(
    timeoutSelf.isError === true && /itself/i.test(timeoutSelf.summary),
    "the bot refuses to time itself out"
  );

  const untimeoutBot = await callTool("remove_timeout", { member: "Omnicord" });
  expect(untimeoutBot.data?.changed === false, "remove_timeout no-ops when not timed out");

  const bans = await callTool("list_bans");
  expect((bans.data?.bans ?? []).length === 0, "ban list is empty");

  const audit = await callTool("get_audit_log", { limit: 20 });
  expect((audit.data?.entries ?? []).length > 0, "audit log returns entries");
  expect(
    (audit.data?.entries ?? []).some((e) => e.action === "channel_delete"),
    "audit entries carry readable action names"
  );

  const badAction = await callToolRaw("get_audit_log", { action: "made_up_event" });
  expect(badAction.isError === true, "unknown audit action name is rejected with the valid list");

  // Engagement batch: reactions, polls, emojis, invites, webhooks, and
  // scheduled events, all created and removed within the run.

  const reactMsg = await callTool("send_message", {
    channel: "general",
    content: `omnicord engagement acceptance ${Date.now()}`,
  });
  const reactId = reactMsg.data.id;

  const reacted = await callTool("add_reactions", {
    channel: "general",
    message_id: reactId,
    emojis: ["\u2705", "\u274c"],
  });
  expect((reacted.data?.added ?? []).length === 2, "two reactions added in one call");

  const reactors = await callTool("get_reactions", {
    channel: "general",
    message_id: reactId,
    emoji: "\u2705",
  });
  expect(
    (reactors.data?.users ?? []).some((u) => u.bot === true),
    "the bot shows up among reactors"
  );

  await callTool("remove_reaction", {
    channel: "general",
    message_id: reactId,
    emoji: "\u274c",
  });
  const clearGate = await callTool("clear_reactions", {
    channel: "general",
    message_id: reactId,
  });
  const cleared = await callTool("clear_reactions", {
    channel: "general",
    message_id: reactId,
    confirm_token: clearGate.data?.confirm_token,
  });
  expect(cleared.data?.cleared === "all", "gated clear removes all reactions");

  const poll = await callTool("create_poll", {
    channel: "general",
    question: "Omnicord acceptance poll?",
    answers: ["Yes", "Also yes"],
    duration_hours: 1,
  });
  expect(typeof poll.data?.id === "string", "poll posts");

  const openResults = await callTool("get_poll_results", {
    channel: "general",
    message_id: poll.data.id,
  });
  expect(openResults.data?.finalized === false, "fresh poll is open");
  expect((openResults.data?.answers ?? []).length === 2, "poll carries both answers");

  const endedPoll = await callTool("end_poll", {
    channel: "general",
    message_id: poll.data.id,
  });
  expect(endedPoll.data?.ended === true, "own poll ends early");

  // Discord finalizes expired polls asynchronously; poll for the flag
  // instead of racing it.
  let finalized = false;
  for (let i = 0; i < 10; i += 1) {
    const closedResults = await callToolRaw("get_poll_results", {
      channel: "general",
      message_id: poll.data.id,
    });
    if (closedResults.data?.finalized === true) {
      finalized = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(finalized, "ended poll reports finalized");

  // Custom emoji: create from Discord's own default avatar asset, react
  // with it by name, then remove it.
  const emoji = await callTool("create_emoji", {
    name: "omnitest_emoji",
    image_url: "https://cdn.discordapp.com/embed/avatars/0.png",
  });
  expect(typeof emoji.data?.id === "string", "custom emoji uploads from a url");

  const emojiList = await callTool("list_emojis");
  expect(
    (emojiList.data?.emojis ?? []).some((e) => e.name === "omnitest_emoji"),
    "custom emoji appears in the list"
  );

  const customReact = await callTool("add_reactions", {
    channel: "general",
    message_id: reactId,
    emojis: ["omnitest_emoji"],
  });
  expect((customReact.data?.added ?? []).length === 1, "custom emoji resolves by bare name for reactions");

  const emojiGate = await callTool("delete_emoji", { emoji: "omnitest_emoji" });
  const emojiGone = await callTool("delete_emoji", {
    emoji: "omnitest_emoji",
    confirm_token: emojiGate.data?.confirm_token,
  });
  expect(emojiGone.data?.deleted === true, "gated emoji delete works");

  // Invites.
  const invite = await callTool("create_invite", {
    channel: "general",
    max_age_seconds: 600,
    max_uses: 1,
  });
  expect(typeof invite.data?.code === "string", "invite creates with explicit lifetime");

  const inviteInfo = await callTool("get_invite", { code: invite.data.code });
  expect(
    inviteInfo.data?.guild?.id === guildId,
    "invite inspection points at the test server"
  );

  const inviteList = await callTool("list_invites");
  expect(
    (inviteList.data?.invites ?? []).some((i) => i.code === invite.data.code),
    "invite shows in the list"
  );

  const inviteGate = await callTool("delete_invite", { code: invite.data.code });
  const inviteGone = await callTool("delete_invite", {
    code: invite.data.code,
    confirm_token: inviteGate.data?.confirm_token,
  });
  expect(inviteGone.data?.revoked === true, "gated invite revocation works");

  // Webhooks: create, post through with an identity override, verify the
  // token never leaks, rename, delete.
  const hook = await callTool("create_webhook", {
    channel: "general",
    name: "omnitest-hook",
  });
  expect(typeof hook.data?.id === "string", "webhook creates");

  const hookList = await callTool("list_webhooks");
  expect(
    (hookList.data?.webhooks ?? []).some((h) => h.name === "omnitest-hook"),
    "webhook shows in the list"
  );
  expect(
    !JSON.stringify(hookList).toLowerCase().includes("token"),
    "webhook listing never leaks tokens"
  );

  const hookPost = await callTool("send_webhook_message", {
    webhook: "omnitest-hook",
    content: "hello from the acceptance webhook",
    username_override: "Omnitest Crier",
  });
  expect(typeof hookPost.data?.id === "string", "webhook posts a message");

  const hookFeed = await callTool("read_messages", { channel: "general", limit: 5 });
  expect(
    (hookFeed.data?.messages ?? []).some((m) => m.author?.name === "Omnitest Crier"),
    "webhook message carries the identity override"
  );

  await callTool("update_webhook", { webhook: "omnitest-hook", name: "omnitest-hook-renamed" });
  const hookGate = await callTool("delete_webhook", { webhook: "omnitest-hook-renamed" });
  const hookGone = await callTool("delete_webhook", {
    webhook: "omnitest-hook-renamed",
    confirm_token: hookGate.data?.confirm_token,
  });
  expect(hookGone.data?.deleted === true, "gated webhook delete works");

  // Scheduled events: one external, one voice, both canceled.
  const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const endAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

  const extEvent = await callTool("create_event", {
    name: "omnitest-external-event",
    type: "external",
    start_time: startAt,
    end_time: endAt,
    location: "The Void",
    description: "Acceptance run external event.",
  });
  expect(typeof extEvent.data?.id === "string", "external event schedules");

  const voiceEvent = await callTool("create_event", {
    name: "omnitest-voice-event",
    type: "voice",
    channel: "General",
    start_time: startAt,
  });
  expect(typeof voiceEvent.data?.id === "string", "voice event schedules with channel resolution");

  const eventList = await callTool("list_events");
  expect((eventList.data?.events ?? []).length >= 2, "both events listed");

  const attendees = await callTool("get_event_attendees", { event: "omnitest-external-event" });
  expect((attendees.data?.attendees ?? []).length === 0, "fresh event has no attendees");

  const eventUpdate = await callTool("update_event", {
    event: "omnitest-external-event",
    description: "Updated by the acceptance run.",
  });
  expect(
    (eventUpdate.data?.description ?? "").includes("Updated"),
    "event description updates"
  );

  const pastEvent = await callToolRaw("create_event", {
    name: "omnitest-past",
    type: "external",
    start_time: "2020-01-01T00:00:00Z",
    end_time: "2020-01-02T00:00:00Z",
    location: "Yesterday",
  });
  expect(pastEvent.isError === true, "past start time is rejected");

  for (const name of ["omnitest-external-event", "omnitest-voice-event"]) {
    const gate = await callTool("cancel_event", { event: name });
    const canceled = await callTool("cancel_event", {
      event: name,
      confirm_token: gate.data?.confirm_token,
    });
    expect(canceled.data?.canceled === true, `gated cancel removed ${name}`);
  }

  // Message cleanup for this section.
  for (const id of [reactId, poll.data.id, hookPost.data.id]) {
    const gate = await callTool("delete_message", { channel: "general", message_id: id });
    await callTool("delete_message", {
      channel: "general",
      message_id: id,
      confirm_token: gate.data?.confirm_token,
    });
  }
  const engagementSweep = await callTool("read_messages", { channel: "general", limit: 10 });
  expect(
    !(engagementSweep.data?.messages ?? []).some((m) =>
      [reactId, poll.data.id, hookPost.data.id].includes(m.id)
    ),
    "engagement messages cleaned up"
  );

  // Gateway batch: the bot goes online and watches itself act. The
  // connection races server startup, so first wait for it.

  let gatewayUp = false;
  for (let i = 0; i < 30; i += 1) {
    const info = await callToolRaw("get_bot_info");
    if (info.data?.gateway?.status === "connected") {
      gatewayUp = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(gatewayUp, "gateway connects and the bot shows online");

  const subscription = await callTool("subscribe_events", {
    types: ["message_created", "reaction_added", "channel_created"],
    include_bots: true,
  });
  const subId = subscription.data?.subscription_id;
  expect(typeof subId === "string", "subscription opens");

  async function waitForEvent(predicate, label) {
    for (let i = 0; i < 20; i += 1) {
      const batch = await callToolRaw("get_recent_events", {
        subscription_id: subId,
        limit: 100,
      });
      const hit = (batch.data?.events ?? []).find(predicate);
      if (hit) {
        expect(true, label);
        return hit;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(false, label);
    return undefined;
  }

  const gwMsg = await callTool("send_message", {
    channel: "general",
    content: "gateway acceptance marker",
  });
  await waitForEvent(
    (e) => e.type === "message_created" && e.data.message_id === gwMsg.data.id,
    "own message arrives as a gateway event"
  );

  await callTool("add_reactions", {
    channel: "general",
    message_id: gwMsg.data.id,
    emojis: ["\u2705"],
  });
  await waitForEvent(
    (e) => e.type === "reaction_added" && e.data.message_id === gwMsg.data.id,
    "reaction arrives as a gateway event"
  );

  const gwChannel = await callTool("create_channel", { name: "omnitest-gateway" });
  await waitForEvent(
    (e) => e.type === "channel_created" && e.channel_id === gwChannel.data.id,
    "channel creation arrives as a gateway event"
  );

  const subList = await callTool("list_event_subscriptions");
  expect(
    (subList.data?.subscriptions ?? []).some((s) => s.id === subId),
    "subscription shows in the list"
  );

  const unsub = await callTool("unsubscribe_events", { subscription_id: subId });
  expect(unsub.data?.removed === true, "unsubscribe works");
  const deadDrain = await callToolRaw("get_recent_events", { subscription_id: subId });
  expect(deadDrain.isError === true, "draining a removed subscription fails cleanly");

  // Cleanup: the gateway test channel and marker message.
  const gwChanGate = await callTool("delete_channel", { channel: gwChannel.data.id });
  await callTool("delete_channel", {
    channel: gwChannel.data.id,
    confirm_token: gwChanGate.data?.confirm_token,
  });
  const gwMsgGate = await callTool("delete_message", {
    channel: "general",
    message_id: gwMsg.data.id,
  });
  await callTool("delete_message", {
    channel: "general",
    message_id: gwMsg.data.id,
    confirm_token: gwMsgGate.data?.confirm_token,
  });

  // AutoMod batch: a keyword rule's full lifecycle.

  const rule = await callTool("create_automod_rule", {
    name: "omnitest-automod",
    trigger: "keyword",
    keywords: ["omnitestforbidden"],
    actions: ["block", "timeout"],
    timeout_minutes: 1,
  });
  expect(rule.data?.enabled === true, "automod rule creates enabled");
  expect((rule.data?.actions ?? []).includes("timeout"), "automod rule carries both actions");

  const ruleList = await callTool("list_automod_rules");
  expect(
    (ruleList.data?.rules ?? []).some(
      (r) => r.name === "omnitest-automod" && r.trigger === "keyword"
    ),
    "automod rule shows in the list with a readable trigger"
  );

  const ruleOff = await callTool("update_automod_rule", {
    rule: "omnitest-automod",
    enabled: false,
  });
  expect(ruleOff.data?.enabled === false, "automod rule disables");

  const ruleGate = await callTool("delete_automod_rule", { rule: "omnitest-automod" });
  const ruleGone = await callTool("delete_automod_rule", {
    rule: "omnitest-automod",
    confirm_token: ruleGate.data?.confirm_token,
  });
  expect(ruleGone.data?.deleted === true, "gated automod delete works");

  // Threads batch: branch from a message, talk inside it by raw ID,
  // manage state and membership, archive, unarchive by ID, delete.

  const origin = await callTool("send_message", {
    channel: "general",
    content: "thread origin marker",
  });
  const thread = await callTool("create_thread", {
    channel: "general",
    name: "omnitest-thread",
    message_id: origin.data.id,
  });
  expect(typeof thread.data?.id === "string", "thread branches from a message");

  const inThread = await callTool("send_message", {
    channel: thread.data.id,
    content: "hello inside the thread",
  });
  expect(typeof inThread.data?.id === "string", "raw thread id resolves for sending");

  const threadFeed = await callTool("read_messages", { channel: thread.data.id });
  expect(
    (threadFeed.data?.messages ?? []).some((m) => m.id === inThread.data.id),
    "thread messages read back"
  );

  const threadList = await callTool("list_threads");
  expect(
    (threadList.data?.active ?? []).some((t) => t.name === "omnitest-thread"),
    "thread shows among active threads"
  );

  await callTool("update_thread", { thread: "omnitest-thread", slowmode_seconds: 5 });
  await callTool("add_thread_member", { thread: "omnitest-thread", member: ownerId });
  const threadMembers = await callTool("list_thread_members", { thread: "omnitest-thread" });
  expect((threadMembers.data?.members ?? []).length >= 2, "added member shows in the thread");
  await callTool("remove_thread_member", { thread: "omnitest-thread", member: ownerId });

  await callTool("update_thread", { thread: "omnitest-thread", archived: true });
  const archivedList = await callTool("list_threads", {
    channel: "general",
    include_archived: true,
  });
  expect(
    (archivedList.data?.archived ?? []).some((t) => t.name === "omnitest-thread"),
    "archived thread shows under include_archived"
  );

  const unarchive = await callTool("update_thread", {
    thread: thread.data.id,
    archived: false,
  });
  expect(
    (unarchive.data?.changed ?? []).includes("unarchived"),
    "archived thread resolves by raw id and unarchives"
  );

  const threadGate = await callTool("delete_thread", { thread: "omnitest-thread" });
  const threadGone = await callTool("delete_thread", {
    thread: "omnitest-thread",
    confirm_token: threadGate.data?.confirm_token,
  });
  expect(threadGone.data?.deleted === true, "gated thread delete works");

  const originGate = await callTool("delete_message", {
    channel: "general",
    message_id: origin.data.id,
  });
  await callTool("delete_message", {
    channel: "general",
    message_id: origin.data.id,
    confirm_token: originGate.data?.confirm_token,
  });

  // Forums batch: a forum channel with tags, a tagged post, replies, tag
  // management, and teardown.

  const forumChan = await callTool("create_channel", {
    name: "omnitest-forum",
    type: "forum",
  });
  expect(typeof forumChan.data?.id === "string", "forum channel creates");

  const bugTag = await callTool("create_forum_tag", {
    forum: "omnitest-forum",
    name: "bug",
  });
  expect(typeof bugTag.data?.id === "string", "forum tag creates with an id");
  await callTool("create_forum_tag", { forum: "omnitest-forum", name: "feature" });

  const forumPost = await callTool("create_forum_post", {
    forum: "omnitest-forum",
    title: "omnitest-post",
    content: "opening message of the acceptance post",
    tags: ["bug"],
  });
  expect((forumPost.data?.tags ?? []).includes("bug"), "post carries its tag by name");

  const taggedPosts = await callTool("list_forum_posts", {
    forum: "omnitest-forum",
    tag: "bug",
  });
  expect(
    (taggedPosts.data?.posts ?? []).some((p) => p.title === "omnitest-post"),
    "tag filter finds the post"
  );

  const forumReply = await callTool("reply_to_forum_post", {
    post: "omnitest-post",
    content: "a reply in the post",
  });
  expect(typeof forumReply.data?.id === "string", "forum post takes replies");

  const retag = await callTool("update_forum_post", {
    post: "omnitest-post",
    tags: ["feature"],
    pinned: true,
  });
  expect(
    (retag.data?.changed ?? []).some((c) => c.includes("pinned")),
    "post pins and retags"
  );

  await callTool("update_forum_tag", {
    forum: "omnitest-forum",
    tag: "bug",
    name: "defect",
  });

  const postGate = await callTool("delete_forum_post", { post: "omnitest-post" });
  const postGone = await callTool("delete_forum_post", {
    post: "omnitest-post",
    confirm_token: postGate.data?.confirm_token,
  });
  expect(postGone.data?.deleted === true, "gated forum post delete works");

  const tagGate = await callTool("delete_forum_tag", {
    forum: "omnitest-forum",
    tag: "defect",
  });
  const tagGone = await callTool("delete_forum_tag", {
    forum: "omnitest-forum",
    tag: "defect",
    confirm_token: tagGate.data?.confirm_token,
  });
  expect(tagGone.data?.deleted === true, "gated forum tag delete works");

  const forumGate = await callTool("delete_channel", { channel: forumChan.data.id });
  await callTool("delete_channel", {
    channel: forumChan.data.id,
    confirm_token: forumGate.data?.confirm_token,
  });

  // Settings batch: widget, server fields, templates, prune, presence,
  // and the honest Community-only error paths.

  const widgetOn = await callTool("update_server_widget", { enabled: true });
  expect(widgetOn.data?.enabled === true, "widget enables");
  const widgetState = await callTool("get_server_widget");
  expect(widgetState.data?.enabled === true, "widget state reads back");
  await callTool("update_server_widget", { enabled: false });

  const afkUp = await callTool("update_server", { afk_timeout_seconds: 900 });
  expect(
    (afkUp.data?.changed ?? []).some((c) => c.includes("900")),
    "server afk timeout updates"
  );
  await callTool("update_server", { afk_timeout_seconds: 300 });

  // A server that never had a welcome screen errors with the Community
  // explanation; one that had a screen configured keeps the data even
  // after Community is turned off. Both are legitimate states.
  const welcome = await callToolRaw("get_welcome_screen");
  expect(
    welcome.isError === true
      ? /Community/i.test(welcome.summary)
      : Array.isArray(welcome.data?.channels),
    "welcome screen reads back or explains the Community requirement"
  );

  const onboarding = await callToolRaw("get_onboarding");
  expect(
    onboarding.isError === true || onboarding.data?.enabled === false,
    "onboarding reads back or fails cleanly"
  );

  const integrations = await callTool("list_integrations");
  expect(Array.isArray(integrations.data?.integrations), "integrations list");

  const template = await callTool("create_server_template", {
    name: "omnitest-template",
    description: "Acceptance snapshot.",
  });
  expect(typeof template.data?.code === "string", "server template creates");

  const templateList = await callTool("list_server_templates");
  expect(
    (templateList.data?.templates ?? []).some((t) => t.code === template.data.code),
    "template shows in the list"
  );

  const synced = await callTool("sync_server_template", { code: template.data.code });
  expect(synced.data?.out_of_sync === false, "template syncs clean");

  const templateGate = await callTool("delete_server_template", {
    code: template.data.code,
  });
  const templateGone = await callTool("delete_server_template", {
    code: template.data.code,
    confirm_token: templateGate.data?.confirm_token,
  });
  expect(templateGone.data?.deleted === true, "gated template delete works");

  // The preview endpoint works for any guild the bot belongs to; the
  // discoverability requirement only applies to outsiders.
  const preview = await callTool("get_server_preview");
  expect(
    typeof preview.data?.members_approximate === "number",
    "preview returns member counts for the bot's own guild"
  );

  // Prune executions are limited to a few per guild every several
  // minutes (Discord error 30040), so repeated test runs only assert the
  // preview, which uses Discord's unlimited count endpoint.
  const pruneGate = await callTool("prune_members", { days: 1 });
  expect(pruneGate.data?.preview?.would_prune === 0, "prune preview counts zero on the test server");

  const presenceIdle = await callTool("set_bot_presence", {
    status: "idle",
    activity_text: "Acceptance run",
  });
  expect(presenceIdle.data?.status === "idle", "presence sets to idle over the gateway");
  await callTool("set_bot_presence", { status: "online" });

  // Community batch: enable the feature for real, run the tests that
  // were previously only error paths, then put everything back.

  await callTool("create_channel", { name: "omnitest-rules", topic: "Rules for the test." });
  await callTool("create_channel", { name: "omnitest-updates", topic: "Mod updates." });

  const communityOn = await callTool("update_server", {
    community: true,
    rules_channel: "omnitest-rules",
    public_updates_channel: "omnitest-updates",
  });
  expect(
    (communityOn.data?.changed ?? []).includes("Community enabled"),
    "Community enables with prerequisites handled"
  );

  const featureCheck = await callTool("get_server_overview");
  expect(
    (featureCheck.data?.features ?? []).includes("COMMUNITY"),
    "server reports the COMMUNITY feature"
  );

  // Announcement channels were impossible before Community; now they are
  // the positive test for the planner's gating logic.
  const announceChan = await callTool("create_channel", {
    name: "omnitest-announce",
    type: "announcement",
  });
  expect(typeof announceChan.data?.id === "string", "announcement channel creates on a Community server");

  const welcomeSet = await callTool("update_welcome_screen", {
    enabled: true,
    description: "Welcome to the acceptance run.",
    channels: [{ channel: "general", description: "Start here" }],
  });
  expect(welcomeSet.data?.updated === true, "welcome screen updates for real");

  const welcomeRead = await callTool("get_welcome_screen");
  expect(
    (welcomeRead.data?.channels ?? []).length === 1,
    "welcome screen reads back with its channel card"
  );

  // Onboarding needs at least seven default channels, five sendable.
  // general, rules, updates, announce, plus three fillers makes seven.
  for (let i = 1; i <= 3; i += 1) {
    await callTool("create_channel", { name: `omnitest-onb-${i}` });
  }
  await callTool("create_role", { name: "omnitest-onb-role", preset: "member" });

  const onboardingSet = await callTool("update_onboarding", {
    enabled: true,
    mode: "default",
    default_channels: [
      "general",
      "omnitest-rules",
      "omnitest-updates",
      "omnitest-announce",
      "omnitest-onb-1",
      "omnitest-onb-2",
      "omnitest-onb-3",
    ],
    prompts: [
      {
        title: "What brings you here?",
        type: "multiple_choice",
        options: [
          { title: "Just looking around", roles: ["omnitest-onb-role"] },
          { title: "Updates please", channels: ["omnitest-updates"] },
        ],
      },
    ],
  });
  expect(onboardingSet.data?.enabled === true, "onboarding enables with a real prompt");
  expect((onboardingSet.data?.prompts ?? []).length === 1, "onboarding carries the prompt");

  const onboardingRead = await callTool("get_onboarding");
  expect(onboardingRead.data?.enabled === true, "onboarding reads back enabled");

  const onboardingOff = await callTool("update_onboarding", { enabled: false });
  expect(onboardingOff.data?.enabled === false, "onboarding disables again");

  // Stickers and soundboard, from the loopback-served generated assets.
  const sticker = await callTool("create_sticker", {
    name: "omnitest_sticker",
    description: "Acceptance sticker.",
    tags: "robot",
    image_url: `http://127.0.0.1:${ASSET_PORT}/sticker.png`,
  });
  expect(typeof sticker.data?.id === "string", "sticker uploads from a generated png");

  const stickerList = await callTool("list_stickers");
  expect(
    (stickerList.data?.stickers ?? []).some((s) => s.name === "omnitest_sticker"),
    "sticker shows in the list"
  );

  await callTool("update_sticker", {
    sticker: "omnitest_sticker",
    description: "Renamed by the run.",
  });

  const stickerGate = await callTool("delete_sticker", { sticker: "omnitest_sticker" });
  const stickerGone = await callTool("delete_sticker", {
    sticker: "omnitest_sticker",
    confirm_token: stickerGate.data?.confirm_token,
  });
  expect(stickerGone.data?.deleted === true, "gated sticker delete works");

  const soundCreate = await callToolRaw("create_soundboard_sound", {
    name: "omnitest-sound",
    sound_url: `http://127.0.0.1:${ASSET_PORT}/sound.mp3`,
    volume: 0.5,
  });
  expect(soundCreate.isError !== true, "soundboard sound uploads from generated audio");

  if (soundCreate.isError !== true) {
    const soundList = await callTool("list_soundboard_sounds");
    expect(
      (soundList.data?.sounds ?? []).some((s) => s.name === "omnitest-sound"),
      "sound shows in the list"
    );

    const soundUpdate = await callTool("update_soundboard_sound", {
      sound: "omnitest-sound",
      volume: 0.8,
    });
    expect(soundUpdate.data?.volume === 0.8, "sound volume updates");

    const soundGate = await callTool("delete_soundboard_sound", { sound: "omnitest-sound" });
    const soundGone = await callTool("delete_soundboard_sound", {
      sound: "omnitest-sound",
      confirm_token: soundGate.data?.confirm_token,
    });
    expect(soundGone.data?.deleted === true, "gated sound delete works");
  }

  // Put the server back: welcome screen off, Community off, then sweep
  // the channels and role this section created.
  await callTool("update_welcome_screen", { enabled: false });
  const communityOff = await callTool("update_server", { community: false });
  expect(
    (communityOff.data?.changed ?? []).includes("Community disabled"),
    "Community disables cleanly"
  );

  for (const name of [
    "omnitest-announce",
    "omnitest-onb-1",
    "omnitest-onb-2",
    "omnitest-onb-3",
    "omnitest-rules",
    "omnitest-updates",
  ]) {
    const chanGate = await callTool("delete_channel", { channel: name });
    await callTool("delete_channel", {
      channel: name,
      confirm_token: chanGate.data?.confirm_token,
    });
  }
  const onbRoleGate = await callTool("delete_role", { role: "omnitest-onb-role" });
  await callTool("delete_role", {
    role: "omnitest-onb-role",
    confirm_token: onbRoleGate.data?.confirm_token,
  });

  assetServer.close();

  // Blueprint store batch: export the pristine server, prove drift
  // detection in both directions, and close with the round-trip test:
  // re-applying an export must create nothing.

  // Leftover saved blueprints from an interrupted run would collide on
  // name; sweep them defensively first.
  for (const name of ["omnitest-baseline", "omnitest-structure"]) {
    const leftover = await callToolRaw("get_blueprint", { blueprint: name });
    if (!leftover.isError) {
      const g = await callToolRaw("delete_blueprint", { blueprint: name });
      if (g.data?.confirm_token) {
        await callToolRaw("delete_blueprint", {
          blueprint: name,
          confirm_token: g.data.confirm_token,
        });
      }
    }
  }

  const baseline = await callTool("export_server_blueprint", {
    save_as: "omnitest-baseline",
  });
  expect(typeof baseline.data?.saved_id === "string", "export saves straight to the store");
  expect(
    (baseline.data?.blueprint?.categories ?? []).length === 2,
    "pristine server exports its two default categories"
  );
  expect(
    (baseline.data?.blueprint?.roles ?? []).length === 0,
    "managed and everyone roles stay out of the export"
  );

  const bpList = await callTool("list_blueprints");
  expect(
    (bpList.data?.blueprints ?? []).some((b) => b.name === "omnitest-baseline"),
    "exported blueprint shows in the store"
  );

  const cleanDiff = await callTool("diff_blueprint", { blueprint: "omnitest-baseline" });
  expect(cleanDiff.data?.in_sync === true, "pristine server diffs clean against its own export");
  expect(
    (cleanDiff.data?.extra?.channels ?? []).length === 0,
    "no phantom extras on a clean diff"
  );

  const structure = {
    roles: [{ name: "omnitest-bp-role", preset: "member", color: "#ff00aa" }],
    categories: [
      {
        name: "omnitest-bp-cat",
        private_to: ["omnitest-bp-role"],
        channels: [
          {
            name: "omnitest-bp-chan",
            topic: "drift me",
            read_only: true,
            posting_roles: ["omnitest-bp-role"],
          },
        ],
      },
    ],
  };
  await callTool("save_blueprint", { name: "omnitest-structure", blueprint: structure });

  const beforeBuild = await callTool("diff_blueprint", { blueprint: "omnitest-structure" });
  expect(
    beforeBuild.data?.missing?.roles?.length === 1 &&
      beforeBuild.data?.missing?.categories?.length === 1 &&
      beforeBuild.data?.missing?.channels?.length === 1,
    "unbuilt blueprint reports everything missing"
  );

  await callTool("execute_build_plan", { blueprint: structure });

  const afterBuild = await callTool("diff_blueprint", { blueprint: "omnitest-structure" });
  expect(afterBuild.data?.in_sync === true, "built blueprint diffs clean");

  await callTool("update_channel", { channel: "omnitest-bp-chan", topic: "drifted" });
  const drifted = await callTool("diff_blueprint", { blueprint: "omnitest-structure" });
  const driftEntry = (drifted.data?.changed ?? []).find((c) => c.name === "omnitest-bp-chan");
  expect(
    drifted.data?.in_sync === false && driftEntry?.fields?.includes("topic"),
    "topic drift is detected with the field named"
  );

  // The round trip: exporting the server as it stands and re-executing
  // that export must reuse everything and create nothing.
  const roundTrip = await callTool("export_server_blueprint", {});
  const reapplied = await callTool("execute_build_plan", {
    blueprint: roundTrip.data.blueprint,
  });
  expect(reapplied.data?.created === 0, "re-applying an export creates nothing");
  expect((reapplied.data?.reused ?? 0) >= 3, "re-applying an export reuses the structure");

  // Drift in the other direction: the baseline now sees extras.
  const extras = await callTool("diff_blueprint", { blueprint: "omnitest-baseline" });
  expect(
    (extras.data?.extra?.channels ?? []).includes("omnitest-bp-chan") &&
      (extras.data?.extra?.roles ?? []).includes("omnitest-bp-role"),
    "baseline diff reports the new entities as extra"
  );

  // Cleanup: structure entities and both saved blueprints.
  for (const channel of ["omnitest-bp-chan", "omnitest-bp-cat"]) {
    const g = await callTool("delete_channel", { channel });
    await callTool("delete_channel", { channel, confirm_token: g.data?.confirm_token });
  }
  const bpRoleGate = await callTool("delete_role", { role: "omnitest-bp-role" });
  await callTool("delete_role", {
    role: "omnitest-bp-role",
    confirm_token: bpRoleGate.data?.confirm_token,
  });
  for (const name of ["omnitest-baseline", "omnitest-structure"]) {
    const g = await callTool("delete_blueprint", { blueprint: name });
    await callTool("delete_blueprint", { blueprint: name, confirm_token: g.data?.confirm_token });
  }
  const emptyStore = await callTool("list_blueprints");
  expect((emptyStore.data?.blueprints ?? []).length === 0, "blueprint store ends the run empty");

  // P1/P2 parity batches: messaging, members, permissions, structure,
  // diagnostics. Community-gated tools (announcement, stage) and real DMs
  // are exercised by hand, not here.

  // Messaging: get, bulk delete, scheduler.
  const m1 = await callTool("send_message", { channel: "general", content: "parity msg one" });
  const got = await callTool("get_message", { channel: "general", message_id: m1.data.id });
  expect(got.data?.message?.id === m1.data.id, "get_message returns the message");

  const m2 = await callTool("send_message", { channel: "general", content: "parity delete me alpha" });
  const m3 = await callTool("send_message", { channel: "general", content: "parity delete me beta" });
  const bulkGate = await callTool("bulk_delete_messages", { channel: "general", contains: "parity delete me" });
  expect(bulkGate.data?.preview?.count === 2, "bulk delete previews the right count");
  const bulkDone = await callTool("bulk_delete_messages", {
    channel: "general",
    contains: "parity delete me",
    confirm_token: bulkGate.data?.confirm_token,
  });
  expect(bulkDone.data?.deleted === 2, "bulk delete removes the matched messages");

  const soon = new Date(Date.now() + 4000).toISOString();
  const sched = await callTool("schedule_message", {
    channel: "general",
    content: "parity scheduled fire",
    send_at: soon,
  });
  expect(typeof sched.data?.id === "string", "message schedules");
  const schedList = await callTool("list_scheduled_messages");
  expect(
    (schedList.data?.scheduled ?? []).some((s) => s.id === sched.data.id),
    "scheduled message lists"
  );
  // Wait for the scheduler tick to fire it, then confirm it sent and cleared.
  await new Promise((r) => setTimeout(r, 9000));
  const afterFire = await callTool("list_scheduled_messages");
  expect(
    !(afterFire.data?.scheduled ?? []).some((s) => s.id === sched.data.id),
    "one-shot schedule clears after firing"
  );
  const firedFeed = await callTool("read_messages", { channel: "general", limit: 20 });
  const firedMsg = (firedFeed.data?.messages ?? []).find(
    (m) => m.content === "parity scheduled fire"
  );
  expect(Boolean(firedMsg), "scheduled message actually sent");
  const firedId = firedMsg?.id;

  // Members: nickname round trip, remove_role, permissions, voice (empty).
  const nickSet = await callTool("update_member", { member: "Omnicord", nickname: "Parity Bot" });
  expect((nickSet.data?.changed ?? []).some((c) => c.includes("Parity Bot")), "nickname sets");
  await callTool("update_member", { member: "Omnicord", nickname: "" });

  const tempRole = await callTool("create_role", { name: "omnitest-parity-role", preset: "member" });
  await callTool("assign_role", { member: "Omnicord", role: "omnitest-parity-role" });
  const removed = await callTool("remove_role", { member: "Omnicord", role: "omnitest-parity-role" });
  expect(removed.data?.role?.name === "omnitest-parity-role", "remove_role takes the role back");
  const roleHolders = await callTool("get_role_members", { role: "omnitest-parity-role" });
  expect((roleHolders.data?.members ?? []).length === 0, "get_role_members shows none after removal");

  const memberPerms = await callTool("get_member_permissions", { member: "Omnicord" });
  expect(memberPerms.data?.administrator === true, "bot reads as administrator server-wide");

  const explained = await callTool("explain_permissions", { actor: "bot", permission: "manage_channels" });
  expect(explained.data?.allowed === true, "explain_permissions confirms the bot can manage channels");
  const explainedNo = await callTool("explain_permissions", {
    actor: "bot",
    permission: "manage_channels",
    channel: "general",
  });
  expect(typeof explainedNo.data?.allowed === "boolean", "explain_permissions works channel-scoped");

  // Structure: channel/role detail, clone, reorder, permission overwrites.
  const pchan = await callTool("create_channel", { name: "omnitest-parity-chan", topic: "parity" });
  const chDetail = await callTool("get_channel", { channel: pchan.data.id });
  expect(chDetail.data?.topic === "parity", "get_channel returns detail");

  const setPerm = await callTool("set_channel_permissions", {
    channel: pchan.data.id,
    target: "omnitest-parity-role",
    deny: ["view_channel"],
  });
  expect((setPerm.data?.deny ?? []).includes("view_channel"), "set_channel_permissions applies a deny");
  const readPerm = await callTool("get_channel_permissions", { channel: pchan.data.id });
  expect((readPerm.data?.overwrites ?? []).length >= 1, "get_channel_permissions reads it back");
  await callTool("clear_channel_permissions", { channel: pchan.data.id, target: "omnitest-parity-role" });

  const locked = await callTool("lock_channel", { channel: pchan.data.id });
  expect(locked.data?.locked === true, "lock_channel locks");
  const unlocked = await callTool("unlock_channel", { channel: pchan.data.id });
  expect(unlocked.data?.locked === false, "unlock_channel unlocks");

  const clonedChan = await callTool("clone_channel", { channel: pchan.data.id, new_name: "omnitest-parity-clone" });
  expect(typeof clonedChan.data?.id === "string", "clone_channel creates a copy");
  const clonedRole = await callTool("clone_role", { role: "omnitest-parity-role", new_name: "omnitest-parity-role-2" });
  expect(typeof clonedRole.data?.id === "string", "clone_role creates a copy");

  await callTool("reorder_channels", { moves: [{ channel: pchan.data.id, position: 0 }] });

  const bulkRoleGate = await callTool("bulk_update_roles", {
    action: "assign",
    role: "omnitest-parity-role",
    filter: { is_bot: true },
  });
  expect(typeof bulkRoleGate.data?.preview?.count === "number", "bulk_update_roles previews a count");

  // Diagnostics and roster.
  const stages = await callTool("list_stages");
  expect(Array.isArray(stages.data?.stages), "list_stages returns a list");
  const voice = await callTool("list_voice_members", { channel: "General" });
  expect(Array.isArray(voice.data?.members), "list_voice_members returns a list");
  const rateStatus = await callTool("get_rate_limit_status");
  expect(typeof rateStatus.data?.rate_limit_hits === "number", "rate limit status reports counts");
  const servers = await callTool("list_servers");
  expect((servers.data?.servers ?? []).length >= 1, "list_servers lists the bot's guilds");
  const roster = await callTool("list_members");
  expect((roster.data?.members ?? []).length >= 1, "list_members returns the roster");

  // Cleanup for the parity section.
  for (const id of [m1.data.id, firedId]) {
    const g = await callTool("delete_message", { channel: "general", message_id: id });
    if (g.data?.confirm_token) {
      await callTool("delete_message", { channel: "general", message_id: id, confirm_token: g.data.confirm_token });
    }
  }
  for (const channel of [pchan.data.id, clonedChan.data.id]) {
    const g = await callTool("delete_channel", { channel });
    await callTool("delete_channel", { channel, confirm_token: g.data?.confirm_token });
  }
  for (const role of ["omnitest-parity-role", "omnitest-parity-role-2"]) {
    const g = await callTool("delete_role", { role });
    await callTool("delete_role", { role, confirm_token: g.data?.confirm_token });
  }

  console.log(failed ? "\nacceptance: FAILED" : "\nacceptance: all good");
  child.kill();
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error(`acceptance error: ${err.message}`);
  child.kill();
  process.exit(1);
}
