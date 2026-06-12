// Offline unit tests for the pure logic, starting with the name resolver.
// No network, no token, no MCP session. Run with: node scripts/unit.mjs

import { normalize, rankCandidates, resolveOne } from "../dist/discord/resolve.js";

let failures = 0;

function check(condition, label) {
  if (condition) {
    console.log(`ok: ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

// normalize
check(normalize("Support Tickets") === "supporttickets", "normalize strips spaces and case");
check(normalize("#mod-log") === "modlog", "normalize strips sigils and hyphens");
check(normalize("under_score") === "underscore", "normalize strips underscores");

// rankCandidates scoring
const channels = [
  { id: "100000000000000001", name: "general", type: "channel" },
  { id: "100000000000000002", name: "support-tickets", type: "channel" },
  { id: "100000000000000003", name: "support-voice", type: "channel" },
  { id: "100000000000000004", name: "mod-log", type: "channel" },
];

const byId = rankCandidates("100000000000000004", channels);
check(byId[0]?.id === "100000000000000004" && byId[0]?.score === 100, "exact id wins with score 100");

const exact = rankCandidates("general", channels);
check(exact[0]?.name === "general" && exact[0]?.score === 90, "exact name scores 90");

const normalized = rankCandidates("Support Tickets", channels);
check(normalized[0]?.name === "support-tickets" && normalized[0]?.score === 80, "normalized match scores 80");

const substringHits = rankCandidates("support", channels);
check(substringHits.length === 2, "prefix query finds both support channels");

// resolveOne decisions
const unique = resolveOne("mod log", channels);
check("match" in unique && unique.match.name === "mod-log", "unique normalized match resolves");

const ambiguous = resolveOne("support", channels);
check("candidates" in ambiguous && ambiguous.candidates.length === 2, "ambiguous query returns candidates");

const missing = resolveOne("nonexistent", channels);
check("candidates" in missing && missing.candidates.length === 0, "no match returns empty candidates");

// Tie-breaking: equal scores prefer the shorter name.
const tied = rankCandidates("supp", channels);
check(tied[0]?.name === "support-voice" || tied[0]?.name === "support-tickets", "tie break returns a support channel first");
check(tied[0]?.name === "support-voice", "shorter name wins the tie");

// Permission math (preflight)

const { PermissionFlagsBits } = await import("discord-api-types/v10");
const {
  computeGuildPermissions,
  computeChannelPermissions,
  highestRolePosition,
  parsePermissionNames,
  PERMISSION_PRESETS,
  ALL_PERMISSIONS,
} = await import("../dist/discord/preflight.js");

const P = PermissionFlagsBits;
const GUILD = "200000000000000001";
const BOT = "200000000000000099";

const roles = [
  { id: GUILD, permissions: String(P.ViewChannel | P.SendMessages), position: 0 },
  { id: "200000000000000002", permissions: String(P.ManageMessages), position: 5, name: "Mod" },
  { id: "200000000000000003", permissions: String(P.Administrator), position: 9, name: "Admin" },
];

const basePerms = computeGuildPermissions(["200000000000000002"], GUILD, roles);
check((basePerms & P.SendMessages) !== 0n, "base perms include everyone role");
check((basePerms & P.ManageMessages) !== 0n, "base perms include member role");
check((basePerms & P.BanMembers) === 0n, "base perms exclude ungranted bits");

const adminPerms = computeGuildPermissions(["200000000000000003"], GUILD, roles);
check(adminPerms === ALL_PERMISSIONS, "administrator expands to all permissions");

const denyOverwrite = [
  { id: GUILD, type: 0, allow: "0", deny: String(P.SendMessages) },
];
const channelPerms = computeChannelPermissions(BOT, ["200000000000000002"], GUILD, roles, denyOverwrite);
check((channelPerms & P.SendMessages) === 0n, "everyone overwrite denies send");
check((channelPerms & P.ManageMessages) !== 0n, "overwrite leaves other bits alone");

const memberAllow = [
  { id: GUILD, type: 0, allow: "0", deny: String(P.SendMessages) },
  { id: BOT, type: 1, allow: String(P.SendMessages), deny: "0" },
];
const memberPerms = computeChannelPermissions(BOT, ["200000000000000002"], GUILD, roles, memberAllow);
check((memberPerms & P.SendMessages) !== 0n, "member overwrite outranks everyone deny");

const adminChannel = computeChannelPermissions(BOT, ["200000000000000003"], GUILD, roles, denyOverwrite);
check(adminChannel === ALL_PERMISSIONS, "administrator bypasses overwrites");

check(highestRolePosition(["200000000000000002", "200000000000000003"], roles) === 9, "highest role position found");

const parsed = parsePermissionNames(["manage_messages", "BAN MEMBERS", "Bogus"]);
check((parsed.bits & P.ManageMessages) !== 0n, "snake_case permission name parses");
check((parsed.bits & P.BanMembers) !== 0n, "spaced uppercase name parses");
check(parsed.unknown.length === 1 && parsed.unknown[0] === "Bogus", "unknown names reported");

check((PERMISSION_PRESETS.member & P.SendMessages) !== 0n, "member preset can send");
check((PERMISSION_PRESETS.member & P.ManageMessages) === 0n, "member preset cannot moderate");
check((PERMISSION_PRESETS.moderator & P.ModerateMembers) !== 0n, "moderator preset can timeout");
check((PERMISSION_PRESETS.admin & P.Administrator) === 0n, "no preset grants administrator");

// Confirmation gate (safety)

const { gateDestructive, __testing } = await import("../dist/safety.js");

function envelopeOf(result) {
  return JSON.parse(result.content[0].text);
}

const gateArgs = { tool: "delete_message", args: { channel: "1", message_id: "2" }, previewSummary: "Would delete." };
const first = gateDestructive({ ...gateArgs });
check(first !== null, "safe mode blocks destructive call without token");
const token = envelopeOf(first).data.confirm_token;
check(typeof token === "string" && token.length === 32, "preview issues a confirm token");
check(envelopeOf(first).data.executed === false, "preview marks executed false");

const wrongArgs = gateDestructive({ ...gateArgs, args: { channel: "1", message_id: "DIFFERENT" }, confirmToken: token });
check(wrongArgs !== null && wrongArgs.isError === true, "token bound to different args is rejected");

const proceed = gateDestructive({ ...gateArgs, confirmToken: token });
check(proceed === null, "valid token allows execution");

const reuse = gateDestructive({ ...gateArgs, confirmToken: token });
check(reuse !== null && reuse.isError === true, "token is single use");

const dry = gateDestructive({ ...gateArgs, dryRun: true });
const dryToken = envelopeOf(dry).data.confirm_token;
__testing.pending.get(dryToken).expiresAt = Date.now() - 1;
const expired = gateDestructive({ ...gateArgs, confirmToken: dryToken });
check(expired !== null && expired.isError === true, "expired token is rejected");

process.env.OMNICORD_SAFE_MODE = "false";
const unsafe = gateDestructive({ ...gateArgs });
check(unsafe === null, "safe mode off executes immediately");
const unsafeDry = gateDestructive({ ...gateArgs, dryRun: true });
check(unsafeDry !== null, "dry run still previews with safe mode off");
delete process.env.OMNICORD_SAFE_MODE;

// Planner (builder)

const { buildPlan } = await import("../dist/builder/planner.js");
const { normalizedChannelName } = await import("../dist/builder/blueprint.js");

check(normalizedChannelName("My Cool Chat", "text") === "my-cool-chat", "text channel names normalize like Discord");
check(normalizedChannelName("Game Room 1", "voice") === "Game Room 1", "voice channel names keep case and spaces");

const emptyLive = {
  channels: [],
  roles: [{ id: GUILD, permissions: "0", position: 0, name: "@everyone" }],
  guildFeatures: [],
  botPermissions: ALL_PERMISSIONS,
};

const goodPlan = buildPlan(
  {
    roles: [{ name: "Mod", preset: "moderator" }],
    categories: [
      { name: "Info", channels: [{ name: "welcome", read_only: true, posting_roles: ["Mod"] }] },
    ],
    channels: [{ name: "general" }],
  },
  emptyLive
);
check(goodPlan.errors.length === 0, "valid blueprint plans clean");
check(goodPlan.steps[0].action === "create_role", "roles come first in the plan");
check(goodPlan.steps[1].action === "create_category", "categories come second");
check(goodPlan.steps.filter((s) => s.action === "create_channel").length === 2, "all channels planned");

const emptyBp = buildPlan({}, emptyLive);
check(emptyBp.errors.length === 1, "empty blueprint is rejected");

const dupRole = buildPlan(
  { roles: [{ name: "Mod" }, { name: "mod" }] },
  emptyLive
);
check(dupRole.errors.some((e) => e.includes("twice")), "duplicate role names rejected");

const nameClash = buildPlan(
  { channels: [{ name: "My Chat" }, { name: "my-chat" }] },
  emptyLive
);
check(nameClash.errors.some((e) => e.includes("collapse")), "normalized channel collisions rejected");

// Text and voice namespaces are separate on Discord. Regression tests for
// the cross-family matching bug found in the first Claude Desktop run.
const mixedFamilies = buildPlan(
  { channels: [{ name: "general" }, { name: "General", type: "voice" }] },
  emptyLive
);
check(mixedFamilies.errors.length === 0, "text and voice channels may share a name");

const noCrossReuse = buildPlan(
  { channels: [{ name: "general" }] },
  { ...emptyLive, channels: [{ id: "20", name: "General", type: 2 }] }
);
check(noCrossReuse.steps[0].exists === undefined, "text channel never reuses a voice channel of the same name");

const voiceReuse = buildPlan(
  { channels: [{ name: "General", type: "voice" }] },
  { ...emptyLive, channels: [{ id: "21", name: "general", type: 2 }] }
);
check(voiceReuse.steps[0].exists?.id === "21", "voice channel reuses an existing voice channel case-insensitively");

const badRef = buildPlan(
  { channels: [{ name: "secret", private_to: ["Ghost Role"] }] },
  emptyLive
);
check(badRef.errors.some((e) => e.includes("Ghost Role")), "unknown role reference rejected");

const liveRoleRef = buildPlan(
  { channels: [{ name: "secret", private_to: ["VIP"] }] },
  {
    ...emptyLive,
    roles: [...emptyLive.roles, { id: "3", permissions: "0", position: 1, name: "VIP" }],
  }
);
check(liveRoleRef.errors.length === 0, "live role reference accepted");

// Community gating, matching live API behavior probed June 2026: forums
// work on any server; announcement and stage need the COMMUNITY feature.
const forumNoCommunity = buildPlan(
  { channels: [{ name: "help", type: "forum" }] },
  emptyLive
);
check(forumNoCommunity.errors.length === 0, "forum without Community is allowed");

const stageNoCommunity = buildPlan(
  { channels: [{ name: "Town Hall", type: "stage" }] },
  emptyLive
);
check(stageNoCommunity.errors.some((e) => e.includes("Community")), "stage without Community rejected");

const announcementWithCommunity = buildPlan(
  { channels: [{ name: "news", type: "announcement" }] },
  { ...emptyLive, guildFeatures: ["COMMUNITY"] }
);
check(announcementWithCommunity.errors.length === 0, "announcement with Community accepted");

const voiceTopic = buildPlan(
  { channels: [{ name: "Lounge", type: "voice", topic: "no topics in voice" }] },
  emptyLive
);
check(voiceTopic.warnings.some((w) => w.includes("dropped")), "voice topic warns and drops");
check(voiceTopic.errors.length === 0, "voice topic is not fatal");

const postingNoReadonly = buildPlan(
  { channels: [{ name: "rules", posting_roles: ["Mod"] }], roles: [{ name: "Mod" }] },
  emptyLive
);
check(postingNoReadonly.errors.some((e) => e.includes("read_only")), "posting_roles without read_only rejected");

const collision = buildPlan(
  { channels: [{ name: "general" }] },
  {
    ...emptyLive,
    channels: [{ id: "10", name: "general", type: 0 }],
  }
);
check(collision.errors.length === 0, "live name collision is not an error");
check(collision.steps[0].exists?.id === "10", "live collision marks reuse");

const overCategoryCap = buildPlan(
  {
    categories: [
      {
        name: "Big",
        channels: Array.from({ length: 51 }, (_, i) => ({ name: `c-${i}` })),
      },
    ],
  },
  emptyLive
);
check(overCategoryCap.errors.length > 0, "51 channels in a category rejected by schema or planner");

const noPerms = buildPlan(
  { channels: [{ name: "general" }] },
  { ...emptyLive, botPermissions: 0n }
);
check(noPerms.errors.some((e) => e.includes("Manage Channels")), "missing Manage Channels caught at plan time");

const badPermName = buildPlan(
  { roles: [{ name: "Weird", permissions: ["fly_mode"] }] },
  emptyLive
);
check(badPermName.errors.some((e) => e.includes("fly_mode")), "unknown permission name in role rejected");

// Moderation hierarchy rules (preflight)

const { canModerate } = await import("../dist/discord/preflight.js");

const modBase = {
  action: "kick",
  botId: "900000000000000001",
  ownerId: "900000000000000002",
  botTopPosition: 5,
};

const modSelf = canModerate({ ...modBase, targetId: "900000000000000001", targetTopPosition: 0 });
check(modSelf.ok === false && modSelf.reason.includes("itself"), "bot cannot moderate itself");

const modOwner = canModerate({ ...modBase, targetId: "900000000000000002", targetTopPosition: 0 });
check(modOwner.ok === false && modOwner.reason.includes("owner"), "owner is untouchable");

const modHigher = canModerate({ ...modBase, targetId: "900000000000000003", targetTopPosition: 9 });
check(modHigher.ok === false, "higher role target rejected");

const modEqual = canModerate({ ...modBase, targetId: "900000000000000003", targetTopPosition: 5 });
check(modEqual.ok === false, "equal role position rejected for moderation");

const modLower = canModerate({ ...modBase, targetId: "900000000000000003", targetTopPosition: 2 });
check(modLower.ok === true, "strictly lower target allowed");

// Overwrite compiler (builder)

const { compileOverwrites } = await import("../dist/builder/overwrites.js");

const ROLE_MOD = "300000000000000001";
const BOT_ID = "300000000000000099";
const roleMap = new Map([["mod", ROLE_MOD]]);
const VIEW = P.ViewChannel;
const CONNECT = P.Connect;
const SENDS = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;

function findOw(list, id) {
  return list.find((o) => o.id === id);
}

const open = compileOverwrites({ kind: "text" }, roleMap, GUILD, BOT_ID);
check(open.length === 0, "no restrictions compile to no overwrites");

const privText = compileOverwrites(
  { kind: "text", privateTo: ["Mod"] },
  roleMap, GUILD, BOT_ID
);
check((BigInt(findOw(privText, GUILD).deny) & VIEW) !== 0n, "private text denies everyone view");
check((BigInt(findOw(privText, ROLE_MOD).allow) & VIEW) !== 0n, "private text allows the role view");
check((BigInt(findOw(privText, BOT_ID).allow) & VIEW) !== 0n, "bot always keeps view");
check(findOw(privText, BOT_ID).type === 1, "bot overwrite is member type");
check((BigInt(findOw(privText, GUILD).deny) & CONNECT) === 0n, "text privacy does not touch connect");

const privVoice = compileOverwrites(
  { kind: "voice", privateTo: ["Mod"] },
  roleMap, GUILD, BOT_ID
);
check((BigInt(findOw(privVoice, GUILD).deny) & CONNECT) !== 0n, "private voice also denies connect");

const readOnly = compileOverwrites(
  { kind: "text", readOnly: true, postingRoles: ["Mod"] },
  roleMap, GUILD, BOT_ID
);
check((BigInt(findOw(readOnly, GUILD).deny) & SENDS) === SENDS, "read_only denies the send family");
check((BigInt(findOw(readOnly, ROLE_MOD).allow) & P.SendMessages) !== 0n, "posting role can still send");
check((BigInt(findOw(readOnly, BOT_ID).allow) & P.SendMessages) !== 0n, "bot can post in read_only channels");

const both = compileOverwrites(
  { kind: "text", privateTo: ["Mod"], readOnly: true },
  roleMap, GUILD, BOT_ID
);
const everyoneBoth = BigInt(findOw(both, GUILD).deny);
check((everyoneBoth & VIEW) !== 0n && (everyoneBoth & SENDS) === SENDS, "private plus read_only merge on everyone");
check(both.filter((o) => o.id === GUILD).length === 1, "one overwrite per target after merging");

const inherited = compileOverwrites(
  { kind: "text", inheritedPrivateTo: ["Mod"] },
  roleMap, GUILD, BOT_ID
);
check((BigInt(findOw(inherited, GUILD).deny) & VIEW) !== 0n, "category privacy inherits to plain children");

const ownWins = compileOverwrites(
  { kind: "text", privateTo: ["Mod"], inheritedPrivateTo: ["Ghost"] },
  roleMap, GUILD, BOT_ID
);
check(ownWins.every((o) => o.id !== "ghost"), "own private_to overrides inherited");

let threw = false;
try {
  compileOverwrites({ kind: "text", privateTo: ["Ghost"] }, roleMap, GUILD, BOT_ID);
} catch (err) {
  threw = err.constructor.name === "UnknownRoleError";
}
check(threw, "unknown role name throws UnknownRoleError");

check(privText[0].id === GUILD, "everyone overwrite emitted first");
check(privText[privText.length - 1].id === BOT_ID, "bot overwrite emitted last");

// Wizard pure logic

const { mergeClientConfig, envUpsert, inviteUrl, INVITE_CHOICES, clientConfigCandidates } =
  await import("../dist/wizardLib.js");

const entry = { command: "node", args: ["C:\\somewhere\\dist\\index.js"] };

const fromEmpty = JSON.parse(mergeClientConfig(undefined, entry));
check(fromEmpty.mcpServers.omnicord.command === "node", "merge creates config from nothing");

// A config shaped like a real Claude Desktop file: several servers, env
// blocks, and unrelated nested preferences. Everything must survive.
const realShape = JSON.stringify({
  mcpServers: {
    kali: { command: "python", args: ["client.py", "--server", "http://x:5001"] },
    github: {
      command: "docker",
      args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "secret" },
    },
  },
  coworkUserFilesPath: "C:\\Users\\x\\Documents\\Claude",
  preferences: {
    bypassPermissionsModeEnabled: true,
    epitaxyPrefs: { "starred-local-code-sessions": [] },
  },
});
const merged = JSON.parse(mergeClientConfig(realShape, entry));
check(merged.mcpServers.omnicord.args[0] === entry.args[0], "merge adds omnicord");
check(merged.mcpServers.kali.command === "python", "merge keeps other servers");
check(merged.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN === "secret", "merge keeps nested env blocks");
check(merged.preferences.epitaxyPrefs["starred-local-code-sessions"].length === 0, "merge keeps unrelated preferences");
check(merged.coworkUserFilesPath.includes("Documents"), "merge keeps top level strings");

const remerged = JSON.parse(mergeClientConfig(JSON.stringify(merged), { command: "node", args: ["new-path"] }));
check(remerged.mcpServers.omnicord.args[0] === "new-path", "re-running merge replaces the omnicord entry");

let mergeThrew = false;
try {
  mergeClientConfig("not json at all", entry);
} catch {
  mergeThrew = true;
}
check(mergeThrew, "merge refuses to destroy an unparseable config");

const envBase = "# comment stays\nDISCORD_TOKEN=old\n\nOMNICORD_GUILD=\n";
const envNew = envUpsert(envBase, "DISCORD_TOKEN", "fresh");
check(envNew.includes("DISCORD_TOKEN=fresh"), "env upsert replaces the value");
check(envNew.includes("# comment stays"), "env upsert keeps comments");
check(!envNew.includes("DISCORD_TOKEN=old"), "env upsert removes the old value");
const envAppended = envUpsert(envNew, "OMNICORD_PORT", "9000");
check(envAppended.trimEnd().endsWith("OMNICORD_PORT=9000"), "env upsert appends missing keys");
check(envUpsert("", "A", "1") === "A=1\n", "env upsert works on an empty file");

check(
  inviteUrl("123", 8n) === "https://discord.com/oauth2/authorize?client_id=123&scope=bot&permissions=8",
  "invite url is well formed"
);
check(INVITE_CHOICES[0].key === "recommended", "recommended invite choice is first");
check((INVITE_CHOICES[0].permissions & P.Administrator) === 0n, "recommended choice never grants Administrator");
check(INVITE_CHOICES[2].permissions === P.Administrator, "administrator choice is exactly the admin bit");

const candidates = clientConfigCandidates({
  platform: "win32",
  homedir: "C:\\Users\\test",
  appData: "C:\\Users\\test\\AppData\\Roaming",
  localAppData: "C:\\Users\\test\\AppData\\Local",
  cwd: "C:\\proj",
});
check(candidates.some((c) => c.client === "claude-desktop" && c.path.includes("Roaming")), "windows lists the standard desktop path");
check(candidates.some((c) => c.client === "claude-code" && c.path.includes("proj")), "project mcp.json is always offered");
check(candidates.some((c) => c.client === "cursor"), "cursor path is listed");

const macCandidates = clientConfigCandidates({
  platform: "darwin",
  homedir: "/Users/test",
  cwd: "/proj",
});
check(
  macCandidates.some((c) => c.path.includes("Application Support")),
  "macos desktop path is correct"
);

// Emoji resolution (engagement)

const { resolveEmojiInput } = await import("../dist/discord/emoji.js");
const guildEmojis = [
  { id: "400000000000000001", name: "party_blob", animated: false },
  { id: "400000000000000002", name: "party_parrot", animated: true },
];

const unicode = resolveEmojiInput("\u2705", guildEmojis);
check(unicode.ok && unicode.api === "\u2705" && !unicode.custom, "unicode emoji passes through");

const mention = resolveEmojiInput("<a:party_parrot:400000000000000002>", guildEmojis);
check(mention.ok && mention.api === "party_parrot:400000000000000002", "emoji mention parses");

const byName = resolveEmojiInput(":party_blob:", guildEmojis);
check(byName.ok && byName.api === "party_blob:400000000000000001", "custom emoji resolves by name");

const caseName = resolveEmojiInput("PARTY_BLOB", guildEmojis);
check(caseName.ok === true, "emoji name lookup is case-insensitive");

const unknownEmoji = resolveEmojiInput("party", guildEmojis);
check(unknownEmoji.ok === false && (unknownEmoji.candidates ?? []).length === 2, "unknown name suggests partial matches");

// Image validation (engagement)

const { validateImage, toDataUri } = await import("../dist/discord/images.js");
check(validateImage("image/png", 1000, 262144) === null, "small png passes");
check(validateImage("image/png; charset=binary", 1000, 262144) === null, "content type parameters are ignored");
check(validateImage("image/png", 300000, 262144) !== null, "oversized image rejected");
check(validateImage("text/html", 1000, 262144) !== null, "non-image rejected");
check(validateImage("image/png", 0, 262144) !== null, "empty image rejected");
check(
  toDataUri("image/png", Buffer.from("abc")) === "data:image/png;base64,YWJj",
  "data uri is well formed"
);

// Gateway pure layer

const { gatewayIntentBits, normalizeDispatch, EventBus, SUBSCRIBABLE_TYPES } =
  await import("../dist/discord/gatewayEvents.js");
const { GatewayIntentBits } = await import("discord-api-types/v10");

const fullBits = gatewayIntentBits({ presence: true, members: true, messageContent: true });
check((fullBits & GatewayIntentBits.GuildMembers) !== 0, "members intent requested when portal allows");
check((fullBits & GatewayIntentBits.MessageContent) !== 0, "message content requested when portal allows");
check((fullBits & GatewayIntentBits.GuildPresences) === 0, "presence intent never requested");

const minimalBits = gatewayIntentBits({ presence: false, members: false, messageContent: false });
check((minimalBits & GatewayIntentBits.GuildMembers) === 0, "members intent omitted when portal denies");
check((minimalBits & GatewayIntentBits.MessageContent) === 0, "message content omitted when portal denies");
check((minimalBits & GatewayIntentBits.Guilds) !== 0, "base guilds intent always requested");

const msgEvent = normalizeDispatch("MESSAGE_CREATE", {
  id: "m1",
  channel_id: "c1",
  guild_id: "g1",
  content: "hello world",
  attachments: [],
  author: { id: "u1", username: "tester", bot: false },
});
check(msgEvent?.type === "message_created" && msgEvent.data.message_id === "m1", "message create normalizes");
check(msgEvent?.actor?.name === "tester", "message author carries through");

const joinEvent = normalizeDispatch("GUILD_MEMBER_ADD", {
  guild_id: "g1",
  user: { id: "u2", username: "newbie" },
});
check(joinEvent?.type === "member_joined" && joinEvent.actor?.id === "u2", "member add normalizes");

const reactEvent = normalizeDispatch("MESSAGE_REACTION_ADD", {
  user_id: "u3",
  channel_id: "c1",
  message_id: "m1",
  emoji: { id: null, name: "CHECKMARK" },
});
check(reactEvent?.type === "reaction_added" && reactEvent.data.emoji === "CHECKMARK", "reaction add normalizes");

const voiceEvent = normalizeDispatch("VOICE_STATE_UPDATE", {
  guild_id: "g1",
  channel_id: null,
  user_id: "u4",
});
check(voiceEvent?.type === "voice_state_changed" && voiceEvent.data.joined === false, "voice leave normalizes");

check(normalizeDispatch("TYPING_START", {}) === null, "unhandled dispatch types return null");

const bus = new EventBus();
const sub = bus.subscribe({ id: "s1", types: ["message_created"], channelId: "c1" });
bus.record({ type: "message_created", guild_id: "g1", channel_id: "c1", actor: { id: "u1", name: "x", bot: false }, data: {} });
bus.record({ type: "message_created", guild_id: "g1", channel_id: "OTHER", actor: { id: "u1", name: "x", bot: false }, data: {} });
bus.record({ type: "member_joined", guild_id: "g1", channel_id: "c1", actor: { id: "u1", name: "x", bot: false }, data: {} });
bus.record({ type: "message_created", guild_id: "g1", channel_id: "c1", actor: { id: "b1", name: "bot", bot: true }, data: {} });
check(sub.buffer.length === 1, "bus filters by type, channel, and bot default");

const botSub = bus.subscribe({ id: "s2", types: ["message_created"], includeBots: true });
bus.record({ type: "message_created", guild_id: "g1", channel_id: "c1", actor: { id: "b1", name: "bot", bot: true }, data: {} });
check(botSub.buffer.length === 1, "include_bots records bot events");

const drained = bus.drain("s1", 10);
check(drained.events.length === 1 && drained.remaining === 0, "drain empties the buffer");
check(bus.drain("missing", 10) === undefined, "drain on unknown subscription is undefined");

const capSub = bus.subscribe({ id: "s3", types: ["message_created"], includeBots: true });
for (let i = 0; i < 510; i += 1) {
  bus.record({ type: "message_created", guild_id: "g", channel_id: "c", actor: null, data: { i } });
}
const capDrain = bus.drain("s3", 1);
check(capDrain.dropped > 0, "buffer overflow counts dropped events");
check(capSub.buffer.length <= 500, "buffer respects the cap");

check(bus.unsubscribe("s1") === true && bus.unsubscribe("s1") === false, "unsubscribe is single shot");
check(Object.keys(SUBSCRIBABLE_TYPES).length >= 14, "subscribable type list is published");

// Blueprint export (the sugar decompiler)

const { exportBlueprint } = await import("../dist/builder/export.js");
const { diffBlueprint } = await import("../dist/builder/diff.js");

const XG = "500000000000000001";
const XBOT = "500000000000000099";
const XMOD = "500000000000000002";
const VIEW_CONNECT = (P.ViewChannel | P.Connect).toString();
const VIEW_ONLY = P.ViewChannel.toString();
const SEND_FAM = (
  P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads
).toString();
const SEND_PAIR = (P.SendMessages | P.SendMessagesInThreads).toString();

const xRoles = [
  { id: XG, name: "@everyone", permissions: "0", position: 0 },
  { id: "500000000000000010", name: "BotRole", permissions: "8", position: 5, managed: true },
  { id: XMOD, name: "Mod", permissions: String(P.ManageMessages), position: 3, color: 0xff8800, hoist: true },
  { id: "500000000000000003", name: "Member", permissions: String(P.SendMessages), position: 1 },
];

const staffOverwrites = [
  { id: XG, type: 0, allow: "0", deny: VIEW_CONNECT },
  { id: XMOD, type: 0, allow: VIEW_CONNECT, deny: "0" },
  { id: XBOT, type: 1, allow: VIEW_CONNECT, deny: "0" },
];
const xChannels = [
  { id: "c1", name: "Staff", type: 4, position: 1, permission_overwrites: staffOverwrites },
  { id: "c2", name: "staff-chat", type: 0, parent_id: "c1", position: 0,
    permission_overwrites: [
      { id: XG, type: 0, allow: "0", deny: VIEW_ONLY },
      { id: XMOD, type: 0, allow: VIEW_ONLY, deny: "0" },
      { id: XBOT, type: 1, allow: VIEW_ONLY, deny: "0" },
    ] },
  { id: "c3", name: "rules", type: 0, position: 2,
    permission_overwrites: [
      { id: XG, type: 0, allow: "0", deny: SEND_FAM },
      { id: XMOD, type: 0, allow: SEND_PAIR, deny: "0" },
      { id: XBOT, type: 1, allow: SEND_PAIR, deny: "0" },
    ] },
  { id: "c4", name: "general", type: 0, position: 3, topic: "talk here" },
  { id: "c5", name: "Lounge", type: 2, position: 4 },
  { id: "c6", name: "weird", type: 16, position: 5 },
  { id: "c7", name: "manual-ow", type: 0, position: 6,
    permission_overwrites: [{ id: "500000000000000055", type: 1, allow: VIEW_ONLY, deny: "0" }] },
];

const exported = exportBlueprint(xChannels, xRoles, XG, { botUserId: XBOT });
const bp = exported.blueprint;
check((bp.roles ?? []).length === 2, "export skips everyone and managed roles");
check(bp.roles[0].name === "Member" && bp.roles[1].name === "Mod", "export orders roles bottom first");
check(bp.roles[1].color === "#ff8800" && bp.roles[1].hoist === true, "export keeps role color and hoist");
const staffCat = (bp.categories ?? []).find((c) => c.name === "Staff");
check(staffCat && setLikeEquals(staffCat.private_to, ["Mod"]), "export decompiles category privacy");
check(staffCat.channels[0].name === "staff-chat" && staffCat.channels[0].private_to === undefined, "synced child omits inherited privacy");
const rulesChan = (bp.channels ?? []).find((c) => c.name === "rules");
check(rulesChan?.read_only === true && setLikeEquals(rulesChan.posting_roles, ["Mod"]), "export decompiles read_only with posting roles");
const loungeChan = (bp.channels ?? []).find((c) => c.name === "Lounge");
check(loungeChan?.type === "voice", "export keeps voice type");
check(exported.warnings.some((w) => w.includes("weird")), "inexpressible channel type warns and skips");
check(exported.warnings.some((w) => w.includes("manual-ow")), "foreign member overwrite warns");

function setLikeEquals(a, b) {
  if (!a || a.length !== b.length) return false;
  const lower = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => lower.has(x.toLowerCase()));
}

// Blueprint diff (drift detection)

const syncDiff = diffBlueprint(bp, xChannels, xRoles, XG);
check(syncDiff.in_sync === true, "freshly exported blueprint diffs clean");
check(syncDiff.extra.channels.length === 1 && syncDiff.extra.channels[0] === "weird", "only the skipped channel shows as extra");

const missingDiff = diffBlueprint(
  { roles: [{ name: "Ghost" }], channels: [{ name: "phantom" }] },
  xChannels,
  xRoles,
  XG
);
check(missingDiff.missing.roles.includes("Ghost"), "missing role detected");
check(missingDiff.missing.channels.includes("phantom"), "missing channel detected");
check(missingDiff.in_sync === false, "missing entities break sync");

const changedDiff = diffBlueprint(
  { channels: [{ name: "general", topic: "different topic" }] },
  xChannels,
  xRoles,
  XG
);
const generalChange = changedDiff.changed.find((c) => c.name === "general");
check(generalChange && generalChange.fields.includes("topic"), "topic drift detected");

const familyDiff = diffBlueprint(
  { channels: [{ name: "lounge" }] },
  xChannels,
  xRoles,
  XG
);
check(familyDiff.missing.channels.includes("lounge"), "text blueprint channel never matches a voice channel");

const roleDriftDiff = diffBlueprint(
  { roles: [{ name: "Mod", color: "#0000ff" }] },
  xChannels,
  xRoles,
  XG
);
const modChange = roleDriftDiff.changed.find((c) => c.name === "Mod");
check(modChange && modChange.fields.includes("color"), "role color drift detected");
check(modChange.fields.includes("permissions"), "role permission drift detected");

// Security: path-traversal guards on the file-backed stores

const { cancelSchedule, isValidScheduleId } = await import("../dist/scheduler.js");
const { deleteBlueprint } = await import("../dist/builder/blueprintStore.js");

check(isValidScheduleId("a1b2c3d4e5f60718") === true, "a real 16-hex id is valid");
check(isValidScheduleId("../../../../etc/passwd") === false, "a traversal string is not a valid id");
check(isValidScheduleId("a1b2c3d4e5f6071") === false, "a too-short id is invalid");
check(isValidScheduleId("A1B2C3D4E5F60718") === false, "uppercase is rejected (ids are lowercase hex)");
check(isValidScheduleId("a1b2c3d4e5f60718.json") === false, "an id with an extension is rejected");

// The delete paths must refuse a traversal argument outright, touching
// no filesystem, regardless of what exists on disk.
check(cancelSchedule("../../../../tmp/anything") === false, "cancelSchedule refuses traversal");
check(cancelSchedule("not-hex-id") === false, "cancelSchedule refuses a non-hex id");
check(deleteBlueprint("../../package") === false, "deleteBlueprint refuses traversal");

if (failures > 0) {
  console.error(`\nunit: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nunit: all passed");
