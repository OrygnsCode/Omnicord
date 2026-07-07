# Changelog

All notable changes to Omnicord are recorded here. The format follows
Keep a Changelog, and the project follows semantic versioning. Version
1.0.0 marked the public launch; releases since follow semver.

## 1.1.0 (2026-07-07)

Catches Omnicord up to Discord's 2025 and 2026 API additions: native message
search, recurring events, raid-defense controls, message forwarding, voice
channel status, and profile-scanning AutoMod. Also fixes a permission
regression that stopped the recommended invite from creating events and
expressions.

### Added

- `set_incident_actions`: pauses new invites and DMs between non-friend
  members for up to 24 hours each, Discord's raid-defense security actions.
  With no arguments it reports the current state and any raid Discord flagged
  on its own.
- `forward_message`: forwards a message from one channel into another as a
  quoted snapshot, the way the Discord client's forward does.
- `set_voice_channel_status`: sets or clears the live status line on a voice
  channel, up to 500 characters.
- `create_event` gains `repeat` (daily, weekly, biweekly, monthly) for
  recurring events, and the event digest now reports an event's recurrence.
- `create_automod_rule` gains the `member_profile` trigger, which scans
  usernames, nicknames, and bios instead of message content. It needs a
  Community server, and its block quarantines the member.

### Changed

- `search_messages` now uses Discord's guild message search index instead of
  a bounded history scan. It searches the whole server, or one named channel,
  matches whole words, reads inside embeds and polls, and reports the total
  match count. New filters cover the author, the content type (image, link,
  file, poll, and so on), and pinned state, with recent or relevance sorting
  and paging.

### Fixed

- Creating scheduled events and expressions used the older Manage
  permissions, but since February 23, 2026 Discord requires Create Events and
  Create Expressions. `create_event` and `create_emoji` now request the
  Create permissions, and both are added to the recommended invite, so a bot
  invited that way can create events, emoji, stickers, and soundboard sounds
  again.

## 1.0.3 (2026-06-25)

Setup wizard improvements and a moderation message fix, both found
through a full live stress test of the tool surface.

### Added

- The wizard now offers a client even when it is installed but has no MCP
  config file yet (its config directory is present), instead of dropping
  a first-time MCP user to the manual snippet. It creates the file in
  that case.
- Cursor project scope (`.cursor/mcp.json`) alongside the global Cursor
  config.

### Changed

- The registration step states up front that it only adds an `omnicord`
  entry, leaves everything else as-is, and backs up the original first.

### Fixed

- The owner-protection message used naive past tense, so a ban read
  "cannot be baned." It now reads "banned," with correct forms for kick
  and timeout.
- If a client config file is not valid JSON, the wizard leaves it
  untouched and prints the snippet to paste by hand, instead of failing.

## 1.0.2 (2026-06-12)

Corrects the mcpName casing to match the GitHub namespace exactly
(io.github.OrygnsCode), which the registry validates case-sensitively.

## 1.0.1 (2026-06-12)

Registry metadata for the official MCP registry listing.

### Added

- The mcpName field in package.json and a server.json, both required by
  registry.modelcontextprotocol.io to verify that the npm package and
  the registry listing describe the same server.

## 1.0.0 (2026-06-12)

The public launch. Omnicord is published to npm as `@orygn/omnicord`,
and the repository is public under the Elastic License 2.0.

### Added

- The npx install path is the documented quick start: one command from
  nothing to the setup wizard.
- A macOS runner in CI alongside Linux and Windows.
- CI and npm version badges in the README.

## 0.8.4 (2026-06-11)

Wizard polish and a stable data home for installed copies, both driven
by a full dress rehearsal of the npx install flow.

### Added

- Installed copies (npx, global installs) now keep the token and saved
  data in a `.omnicord` folder in the user profile instead of inside the
  package directory, so they survive npm cache cleans and version
  upgrades. Source checkouts keep everything next to package.json as
  before. The server reads the profile location as its final .env
  fallback, and a troubleshooting entry covers cache-clean recovery.
- The wizard opens with a proper banner and uses color when the output
  is a terminal: green and red live-check results, highlighted step
  headers, dimmed hints and defaults. Color turns itself off for piped
  output and NO_COLOR, so scripted runs see plain text.

### Changed

- The client registration step now defaults to the client the wizard
  actually detected on the machine instead of the print-a-snippet
  fallback, with a hint that pressing Enter is the right move when
  unsure.
- The restart instruction moved into the closing summary as an explicit
  two-step list (fully restart the client, then ask for a setup check),
  because it was getting lost in the flow.
- The README was rebuilt around a capability table, a how-it-works
  section, and the safety model, with badges and a documentation index.

## 0.8.3 (2026-06-11)

AutoMod keyword presets, found through live rehearsal: models asked to
build a slur filter had to write the word list themselves because the
tool only offered custom keywords.

### Added

- create_automod_rule now supports the keyword_preset trigger with
  Discord's maintained word lists (profanity, sexual_content, slurs), so
  no word list ever needs to be written or generated. The description
  steers models to prefer the slurs preset for hate-speech filtering.
- allow_list support on keyword and keyword_preset rules for exempting
  words.
- list_automod_rules now reports presets and allow lists on existing
  rules.
- Discord's constraints are enforced with clear errors: no timeout
  action on spam or keyword_preset rules, presets only on the preset
  trigger, and no mixing custom keywords into preset rules.

### Changed

- The wizard's Full Administrator invite option no longer frames itself
  as only for throwaway servers; it now notes that the safety gate
  confirms destructive actions at every permission level. Matching
  updates in getting-started and SECURITY.md.

## 0.8.2 (2026-06-11)

Tool-description polish for model comprehension, grounded in current
tool-use guidance. No behavior change; descriptions only.

### Changed

- Disambiguated the tool clusters most likely to cause wrong-tool
  selection, each now naming its alternatives: the three senses of
  "events" (create_event for scheduled community events, subscribe_events
  for live activity, schedule_message for timed messages), the send family
  (send_message, send_dm, send_webhook_message, schedule_message), member
  lookup (search_members, list_members, get_member, get_role_members,
  find), threads versus forum posts, and the audit log versus live events.
- Descriptions now lead with what the tool does, the highest-signal first.
- Documented the description conventions in the tool catalog so future
  tools stay consistent.

## 0.8.1 (2026-06-11)

Security self-audit against the OWASP MCP Top 10. Findings and the full
posture are documented in SECURITY.md. npm audit reports zero
vulnerabilities.

### Fixed

- Path traversal (high): a record id used by the saved-blueprint and
  scheduled-message stores flowed into a filesystem path, so a crafted id
  could reference a file outside the store. Both stores now validate that
  every id is exactly sixteen lowercase hex characters before building any
  path, and delete paths refuse a malformed id without touching disk.
- Mention safety (medium): native polls and new forum posts did not
  suppress mentions the way every other send path does. All message
  creation now suppresses mentions unless a caller deliberately opts in,
  so an injected payload cannot become a mass-ping.
- Resource bound (low): the number of concurrent event subscriptions is
  now capped, alongside the existing per-subscription buffer cap.

### Added

- SECURITY.md: threat model, OWASP MCP Top 10 mapping, an adversarial
  review of the confirmation gate, and operator guidance.

## 0.8.0 (2026-06-11)

Parity completion: 33 new tools (148 total) closing every remaining gap
against the catalog, which was built as the competitor superset. Only the
four application-command tools stay deferred.

### Added

- Messaging: get_message, send_dm (gracefully handles closed DMs),
  bulk_delete_messages (filtered, gated, respects the 14-day limit),
  crosspost_message, and a persistent message scheduler (schedule, list,
  cancel) that catches up anything due during downtime.
- Member administration: update_member (nickname and voice state, with
  the bot's own nickname routed correctly), disconnect_member,
  remove_role, get_member_permissions, and list_voice_members backed by a
  gateway voice-state cache.
- Channel permissions: get, set, and clear overwrites; lock and unlock;
  and explain_permissions, which answers whether an actor can do
  something and why through the full role and overwrite chain.
- Structure: get_channel, clone_channel, clone_role, reorder_channels,
  reorder_roles, follow_announcement_channel, and bulk_update_roles with
  a member filter and the confirmation gate.
- Stage instances: list, start, update, end.
- Roster: list_servers, list_members, get_role_members.
- Diagnostics: get_rate_limit_status, backed by a live observer on the
  request layer.

### Fixed

- update_member now sets the bot's own nickname through the correct
  endpoint instead of failing with a 403.
- remove_role and bulk_update_roles now match assign_role's hierarchy
  rule (warn on an equal-position role rather than hard-refusing), which
  matches how Discord actually treats an administrator bot.

## 0.7.0 (2026-06-11)

The blueprint store: 6 new tools, bringing the total to 120, and
completing the builder's config-as-code story.

### Added

- A local blueprint store (flat JSON files, location configurable with
  OMNICORD_DATA_DIR): save, list, fetch by name or ID, and gated delete.
- export_server_blueprint: snapshot any live server into a portable
  blueprint. Permission overwrites are decompiled back into the
  blueprint's visibility model where they fit, with honest warnings
  where they do not; children synced to their category's privacy export
  unmarked. Exports always validate against the blueprint schema, and
  re-applying an export to the same server creates nothing, which the
  acceptance suite proves on every run.
- diff_blueprint: drift detection between a saved design and the live
  server. Reports what is missing, what changed (down to the field), and
  what exists that the design never mentioned.

## 0.6.1 (2026-06-11)

Fixes from the second third-party client test, run over a flaky network.

### Fixed

- Network-level failures (connection timeouts, resets, DNS trouble) now
  come back as a readable envelope with a retry hint instead of raw
  undici stack noise. The model retried correctly even with the noise;
  now it does not have to guess.
- Creating a thread from a system notice (like a join message) explains
  that Discord forbids it and suggests picking a regular message, rather
  than surfacing bare error 50068.
- The onboarding description claimed Discord enforces seven default
  channels; the live test showed the API accepts fewer, so the
  description now matches observed behavior.
- The welcome screen acceptance check now accepts both legitimate
  states: configured data persists even after Community is disabled.

## 0.6.0 (2026-06-10)

Community management and the expression set completed: 9 new tools,
bringing the total to 114.

### Added

- Community enablement: update_server can now turn the Community feature
  on and off, handling Discord's prerequisites (rules channel, updates
  channel, notification and filter settings) in one call.
- Full onboarding configuration: prompts with channel and role granting
  options, default channels, modes, and the enabled state, with names
  resolved up front and Discord's seven-channel constraint documented in
  the tool itself.
- Stickers: list, upload from an image URL (png, apng, or gif at 320 by
  320 and up to 512 KB, as multipart), edit metadata, gated delete.
- Soundboard: list, upload from an audio URL (mp3 or ogg up to 512 KB
  and 5.2 seconds, as a base64 data URI), rename and volume control,
  gated delete, with optional emoji labels resolved like reactions.
- The acceptance suite now enables Community on the live test server,
  exercises announcement channels, the welcome screen, and onboarding
  for real, then reverts everything; sticker and sound uploads run from
  assets the suite generates byte by byte and serves over loopback.

## 0.5.0 (2026-06-10)

Server settings and identity: 15 new tools, bringing the total to 105.

### Added

- Server editing: name, description, verification level, AFK behavior,
  and the system channel, each preflighted and reported field by field.
- Widget, welcome screen, and onboarding tools, with honest errors where
  Discord requires the Community feature instead of raw status codes.
- Integrations: list what is installed and remove one through the
  confirmation gate.
- Server templates: create a discord.new snapshot, list, sync to the
  current structure, and gated deletion.
- Member pruning with Discord's own exact preview count as the gate
  preview, and a clear message when Discord's per-guild execution
  allowance (a few per several minutes) is used up rather than a silent
  multi-minute wait.
- Bot presence control over the live gateway: status dot and custom
  status text.

## 0.4.0 (2026-06-10)

Threads, forums, and AutoMod: 20 new tools, bringing the total to 90.

### Added

- Threads: create standalone, private, or branched from a message; list
  active and archived; rename, archive, lock, slowmode; membership
  management; gated deletion with archiving suggested as the reversible
  alternative.
- Forums: tagged posts with replies, tag filtering, pinning within the
  forum, retagging, and full tag management on the channel (create,
  rename, moderated flag, gated removal).
- AutoMod: keyword (with regex), spam, and mention-flood rules with
  block, alert, and timeout actions, running on Discord's own
  infrastructure around the clock; enable, disable, edit, and gated
  deletion.
- Channel resolution now falls back to a direct ID lookup, so threads,
  forum posts, and just-created channels resolve everywhere a channel
  parameter is accepted.

## 0.3.0 (2026-06-10)

The gateway: the bot is online, and it can watch the server in real time.

### Added

- A live gateway connection, on by default whenever a token is set
  (disable with OMNICORD_GATEWAY=off). The bot's presence shows online
  while Omnicord runs. Requested intents are computed from what the
  Developer Portal actually has enabled, so a disallowed-intent
  disconnect cannot happen.
- Real-time event subscriptions: subscribe_events records messages,
  joins and leaves, reactions, channel and role changes, bans, and voice
  movement into a per-subscription buffer (500 events, oldest dropped
  and counted); get_recent_events drains it; list and unsubscribe round
  it out. Events from bots are filtered out unless asked for. Channel
  filtering supported.
- Gateway state in diagnostics: get_bot_info reports it and
  run_setup_check explains it, including the off and error cases. A
  gateway failure never breaks REST tools.

### Changed

- Node 20 or newer is now required, in line with the gateway library.

## 0.2.0 (2026-06-10)

Engagement and community parity: 26 new tools, bringing the total to 66.

### Added

- Reactions: add several at once, remove own or others', gated clearing,
  and reaction listings. Custom emoji resolve by bare name, full mention,
  or pasted character.
- Native polls: create with up to ten answers and a 32 day maximum
  duration, read live tallies, end own polls early.
- Custom emojis: list with usage syntax, upload from an image URL within
  Discord's 256 KB limit, rename, gated delete.
- Invites: create with deliberate defaults (24 hour expiry unless never
  is asked for explicitly), inspect any code, list, gated revocation.
- Webhooks: create with optional avatar, list without ever exposing
  tokens, post through with display name and avatar overrides, move and
  rename, gated delete.
- Scheduled events: voice, stage, and external events with lifecycle
  transitions (start, end), attendee listings, and gated cancellation.

## 0.1.0 (2026-06-10)

First feature-complete core, developed and verified against a live test
server end to end.

### Added

- 40 tools across six groups: diagnostics (setup check with live intent
  detection), reads (server overview, channels, roles, messages with
  bounded search, members, the universal name resolver), writes (messages
  with embeds and mention safety, channels, roles with vetted permission
  presets), the server builder (blueprint validation, staged plans,
  dependency-ordered execution with permission overwrite compilation),
  management (channel and role updates, gated deletes, message edit and
  pins), and moderation (timeout, kick, ban including ban by ID, bulk ban,
  ban list, audit log with readable action names).
- Confirmation gate for destructive operations: first call previews and
  issues a single-use token bound to the exact action; only the repeated
  call with that token executes. Safe mode is on by default.
- Permission preflight engine implementing Discord's resolution rules,
  with hierarchy, owner, and self protection checked before the API is
  ever asked.
- Two transports: stdio for desktop MCP clients, and Streamable HTTP with
  strict security defaults (refuses non-loopback binds without a bearer
  token, constant-time token comparison, origin and host validation
  against DNS rebinding, public health endpoint).
- Interactive setup wizard (omnicord init): masked token input, live
  token and intent validation, invite URL generation with a
  least-privilege default, and client config writing with backups for
  Claude Desktop (including the Microsoft Store build), Cursor, Windsurf,
  and project-level Claude Code.
- Test suites: pure-logic unit checks, stdio protocol smoke, HTTP
  transport and security smoke, and a self-cleaning live acceptance run
  against a real Discord server.
