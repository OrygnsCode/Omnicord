# Omnicord Tool Catalog

Version: 1.1
Status: shipped; the contract the implementation follows
Owner: Orygn LLC

This document is the contract for the Omnicord tool surface. Every tool the server exposes is listed here with its tier, destructiveness, required Discord permission, key parameters, and behavior. The implementation and the registry listings derive from this file. Change the contract here first, then change code.

Totals: 151 tools implemented and shipped, 15 in the always-loaded core set and 136 loaded on demand. A few additional tools, notably application-command management, are specified in this contract but deferred and not yet shipped.

## 1. Design conventions

These rules apply to every tool. Individual tool entries only document what differs from them.

### 1.1 Naming

Tools are named `verb_object` in snake_case: `create_channel`, `ban_member`, `list_roles`. No `discord_` prefix; the server itself is the namespace. Verbs are drawn from a fixed set: get, list, search, find, create, update, delete, send, read, assign, remove, and a small number of domain verbs (ban, kick, timeout, pin, subscribe).

### 1.1b Description conventions

Tool descriptions are written for the model that selects and calls them,
following the same principles a good API would use for a new teammate.
Grounded in current tool-use guidance (Anthropic's "writing tools for
agents," the OWASP and MCP best-practice notes):

- Lead with what the tool does in the first clause. A model may not read
  the whole description, so the most important information comes first.
- Disambiguate against similar tools explicitly. Where several tools could
  plausibly match an intent, the description names the alternatives ("for
  X use other_tool"). This is the single most effective defense against
  wrong-tool selection. The known clusters: the three senses of "events"
  (scheduled community events via create_event, live activity via
  subscribe_events, timed messages via schedule_message); the send family
  (send_message, send_dm, send_webhook_message, schedule_message); member
  lookup (search_members, list_members, get_member, get_role_members,
  find); threads versus forum posts; and the audit log versus live events.
- State constraints and what the tool does not do, not just what it does.
- Tell the model that destructive tools are safe to call: the first call
  only previews and returns a confirm token, so the model should call them
  and relay the preview rather than refusing.
- Parameter descriptions carry formats and examples (ISO time, name-or-id,
  hex color) and use unambiguous names.

### 1.2 Entity references

Any parameter that names a Discord entity (channel, role, member, emoji, thread, webhook, event) accepts either a snowflake ID or a name. Name resolution runs in order: exact ID match, exact name match, normalized match (case, hyphens, spaces ignored), substring match. If resolution is ambiguous or low confidence, the tool does not guess. It returns a `candidates` list in the output envelope and asks the caller to disambiguate. The `find` tool exposes this resolver directly.

`guild` is an optional parameter on every guild-scoped tool. If the server is configured with a default guild, it can be omitted.

### 1.3 Tiers

Two tiers:

- `core`: always present in the tool list. 15 tools, chosen for high frequency and to keep the schema footprint small. Marked with an asterisk in the tables below.
- `extended`: registered with the server but surfaced on demand, via client-side tool search or via `tools/list_changed` after a discovery call. A client that loads everything anyway still works; the tiering is an optimization, not a gate.

Tier is orthogonal to authorization. A tool being loaded does not mean the caller may use it (see 1.8).

### 1.4 Destructive operations

A tool is classified destructive (D = yes below) if it deletes content, removes access, punishes a user, or fans out a change to many entities at once. Destructive tools share this behavior:

- They accept `dry_run: boolean`. A dry run returns a preview of exactly what would happen (entities affected, counts, irreversibility notes) and a short-lived `confirm_token`.
- In safe mode (default on), a destructive call without a valid `confirm_token` executes nothing and returns the preview instead. Passing the token back executes for real.
- Safe mode can be disabled per deployment for trusted automation.

Tools that merely modify state (update_channel, edit_message) are not destructive but still honor `dry_run` when passed.

### 1.5 Output envelope

Every tool returns the same envelope:

```
{
  "summary":  "One to three plain sentences describing what happened or what was found.",
  "data":     { ... },        // typed payload, documented per tool
  "warnings": [ "..." ],      // non-fatal notes: missing optional perms, partial results
  "cursor":   "..." | null,   // present when more results exist
  "candidates": [ ... ]       // present only when name resolution was ambiguous
}
```

`summary` exists so the model never has to narrate raw JSON back to the user. `data` is kept lean: snowflakes, names, and the fields a caller actually acts on, not the full Discord API object. A `raw: true` parameter is accepted everywhere for callers that want the unmodified API response.

### 1.6 Pagination

List tools accept `limit` (default 25, max 100) and `cursor`. They return `cursor` when more data exists. No tool ever returns an unbounded list.

### 1.7 Errors and preflight

Tools preflight the common failure causes before calling Discord and return actionable messages:

- Role hierarchy: "The bot's highest role (Mod, position 5) is below the target role (Admin, position 8), so Discord will reject this. Move the bot's role higher or pick a lower role."
- Missing permission: names the exact permission and where to grant it.
- Missing intent: names the intent and the Developer Portal toggle.

Discord error codes that slip through are translated to plain language with the original code preserved in `data.discord_error`.

### 1.8 Authorization layers

Two layers, evaluated in order:

1. Discord permission: what the bot can physically do, per guild and channel. Listed in the Requires column below. "none" means any bot in the guild can do it.
2. Gateway intents: privileged intents gate whole capability groups. Members intent gates member listing and search. Message Content intent gates reading and searching message bodies. Voice States gates voice tools and voice events.

### 1.9 Rate limiting

The server owns rate limit coordination so the model never sees a 429 it could have avoided:

- Token bucket per route honoring `X-RateLimit-*` headers, plus the global 50 requests per second bot limit.
- Queue with backpressure; long waits surface as a warning, not an error.
- Invalid-request circuit breaker: 401, 403, and 429 responses are tracked against Discord's 10,000-per-10-minutes Cloudflare ban threshold, and the server throttles itself well before reaching it.
- `get_rate_limit_status` exposes the current state for diagnostics.

### 1.10 Known API gaps the catalog must be honest about

- Pinning: since February 23, 2026 pinning requires the PIN_MESSAGES permission; MANAGE_MESSAGES alone is no longer sufficient. Preflight checks the new permission.
- Voice audio: joining voice to play or capture audio is out of scope for v1 (it requires a separate UDP voice connection, Opus, and DAVE E2EE as of March 1, 2026). Voice tools in v1 are administrative only. Audio is the planned v2 flagship.
- Guild creation: `POST /guilds` only works for bots in fewer than 10 guilds. The v1 product targets building out servers the user creates and invites the bot into, which has no such cap. A from-scratch `create_server` tool is deferred and will require a dedicated builder bot.

## 2. Core set

The 15 always-loaded tools. Chosen so that the two headline flows (chat and operate a server; build out a server from a brief) work without a single discovery round trip.

| Tool | Why core |
|---|---|
| get_server_overview | Orientation. First call in almost every session. |
| list_channels | Needed before nearly any channel-scoped action. |
| find | Universal name-to-entity resolver, kills snowflake hunting. |
| read_messages | The single most frequent read. |
| send_message | The single most frequent write. |
| search_messages | "What did X say about Y" is a top request. |
| search_members | Member lookup precedes most member actions. |
| get_member | Profile, roles, and permissions for one person. |
| create_channel | Highest-frequency build primitive. |
| list_roles | Needed before any role action. |
| create_role | Second build primitive. |
| assign_role | Most frequent member write. |
| plan_server_build | The product headline, step 1: brief to plan. |
| execute_build_plan | The product headline, step 2: plan to server. |
| run_setup_check | Catches the silent failures (intents, perms) that sink every competitor's first-run experience. |

## 3. Server and guild settings (17 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_servers | no | none | (none) | Guilds the bot is in, with IDs, member counts, and the bot's top role. |
| get_server_overview * | no | none | guild | Structured snapshot: name, owner, boost level, features, counts of channels, roles, members, emojis, plus a category-grouped channel outline. |
| update_server | no | Manage Guild | guild, name, description, icon, banner, verification_level, default_notifications, system_channel, rules_channel, afk_channel, afk_timeout, locale | Edits guild settings. Only passed fields change. |
| get_server_preview | no | none | guild | Public preview data for a discoverable guild. |
| get_audit_log | no | View Audit Log | guild, action_type, user, before, limit | Recent audit entries, summarized per entry (who did what to what, when). |
| get_server_widget | no | Manage Guild | guild | Widget settings and invite channel. |
| update_server_widget | no | Manage Guild | guild, enabled, channel | Enables or points the widget. |
| get_welcome_screen | no | Manage Guild | guild | Welcome screen description and channel cards. |
| update_welcome_screen | no | Manage Guild | guild, enabled, description, channels[] | Sets welcome screen content. |
| get_onboarding | no | Manage Guild | guild | Onboarding prompts, options, and default channels. |
| update_onboarding | no | Manage Guild + Manage Roles + Manage Channels | guild, prompts[], default_channels[], enabled, mode | Edits the new-member onboarding flow. |
| list_integrations | no | Manage Guild | guild | Installed integrations (bots, Twitch, YouTube). |
| delete_integration | yes | Manage Guild | guild, integration | Removes an integration. |
| list_server_templates | no | Manage Guild | guild | Templates created from this guild. |
| create_server_template | no | Manage Guild | guild, name, description | Snapshots the guild as a Discord template. |
| sync_server_template | no | Manage Guild | guild, template_code | Re-syncs a template to current guild state. |
| delete_server_template | yes | Manage Guild | guild, template_code | Deletes a template. |

## 4. Channels and categories (15 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_channels * | no | none | guild, type, category | All channels grouped by category, with type, topic, and position. Filterable. |
| get_channel | no | none | channel | Full detail for one channel: settings, permission overwrite summary, forum tags if applicable, active thread count. |
| create_channel * | no | Manage Channels | guild, name, type (text, voice, forum, stage, announcement, category), category, topic, slowmode, nsfw, bitrate, user_limit, region, default_tags[], position, overwrites[] | Creates any channel type. Accepts permission overwrites inline so a private channel is one call, not three. |
| update_channel | no | Manage Channels | channel, name, topic, category, slowmode, nsfw, bitrate, user_limit, region, position, default_tags[] | Edits channel settings. Only passed fields change. |
| delete_channel | yes | Manage Channels | channel | Deletes a channel and everything in it. Dry run reports message and thread counts that would be lost. |
| clone_channel | no | Manage Channels | channel, new_name, include_overwrites | Copies a channel's settings and overwrites into a new channel. |
| reorder_channels | no | Manage Channels | guild, moves[] (channel, position, category) | Batch position and category moves in one call. |
| get_channel_permissions | no | none | channel | Overwrites on the channel, resolved into plain language per role and member. |
| set_channel_permissions | no | Manage Roles | channel, target (role or member), allow[], deny[] | Sets one overwrite. Preflights bot hierarchy. |
| clear_channel_permissions | yes | Manage Roles | channel, target | Removes an overwrite, restoring inheritance. |
| lock_channel | no | Manage Roles | channel, reason | Denies send for @everyone, posts an optional notice. Stores prior state. |
| unlock_channel | no | Manage Roles | channel | Restores the state saved by lock_channel. |
| follow_announcement_channel | no | Manage Webhooks | source_channel, target_channel | Subscribes a channel to an announcement channel. |
| list_voice_members | no | none | channel | Who is in a voice or stage channel, with mute and deafen state. |
| set_voice_channel_status | no | Manage Channels | channel, status (up to 500 characters, empty clears) | Sets the live status line shown on a voice channel. This is the status, not the topic. |

## 5. Threads (8 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| create_thread | no | Create Public Threads | channel, name, message_id (optional, to branch from a message), private, auto_archive, slowmode | Creates a thread, standalone or from a message. Private threads require Create Private Threads. |
| list_threads | no | none | channel or guild, include_archived | Active threads, and archived when asked, with parent and last-activity info. |
| get_thread | no | none | thread | One thread's settings, member count, and state. |
| update_thread | no | Manage Threads | thread, name, archived, locked, slowmode, auto_archive | Edits thread state. Archive and lock live here. |
| delete_thread | yes | Manage Threads | thread | Deletes a thread and its messages. |
| list_thread_members | no | none | thread | Members of a thread. |
| add_thread_member | no | none | thread, member | Adds a member to a thread. |
| remove_thread_member | no | Manage Threads | thread, member | Removes a member from a thread. |

## 6. Forums (8 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| create_forum_post | no | Send Messages | channel, title, content, tags[], files[] | Starts a forum post with applied tags. |
| list_forum_posts | no | none | channel, tag, include_archived, limit | Posts in a forum, filterable by tag. |
| reply_to_forum_post | no | Send Messages in Threads | post, content, files[] | Replies inside a forum post. |
| update_forum_post | no | Manage Threads (others' posts) | post, title, tags[], pinned, locked, archived | Edits post metadata and state. |
| delete_forum_post | yes | Manage Threads | post | Deletes a forum post. |
| create_forum_tag | no | Manage Channels | channel, name, emoji, moderated | Adds an available tag to a forum. |
| update_forum_tag | no | Manage Channels | channel, tag, name, emoji, moderated | Edits a tag. |
| delete_forum_tag | yes | Manage Channels | channel, tag | Removes a tag from the forum and all posts. |

## 7. Messages (16 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| send_message * | no | Send Messages | channel, content, reply_to, embeds[], components (Components V2 layout blocks), files[], silent, allowed_mentions | Sends a message. Components V2 containers, sections, and galleries are first-class. allowed_mentions defaults to none so the model cannot mass-ping by accident. |
| read_messages * | no | Message Content intent | channel, limit, before, after, around, include_thread_starters | Returns a digest: messages with author, role context, timestamps, reply chains resolved, attachments summarized. Not a raw dump. |
| get_message | no | Message Content intent | channel, message_id | One message in full detail, including reactions and components. |
| edit_message | no | own messages: none | channel, message_id, content, embeds[], components | Edits a bot-authored message. |
| delete_message | yes | Manage Messages (others') | channel, message_id, reason | Deletes one message. |
| bulk_delete_messages | yes | Manage Messages | channel, count or message_ids[], filter (author, contains, has) | Bulk delete up to 100 messages under 14 days old. Dry run returns the exact list. |
| search_messages * | no | Read Message History; Message Content intent | query, channel, author, has (image, video, sound, file, sticker, embed, link, poll, snapshot), pinned, sort (recent, relevant), limit, offset | Full-text search over Discord's server message index. Matches whole words across every channel the bot can read, or one named channel, and looks inside embeds and polls, not just message text. Reports the total match count. |
| pin_message | no | Pin Messages | channel, message_id | Pins. Preflights the post-Feb-2026 PIN_MESSAGES permission. |
| unpin_message | no | Pin Messages | channel, message_id | Unpins. |
| list_pinned_messages | no | none | channel | Pinned messages with author and date. |
| crosspost_message | no | Manage Messages | channel, message_id | Publishes an announcement-channel message to followers. |
| forward_message | no | Send Messages | channel, from_channel, message_id, content | Forwards a message from one channel into another as a quoted snapshot, the way the client's forward does. An optional note posts as its own message just before the forward, since Discord does not allow text on a forward. |
| send_dm | no | none | user, content, embeds[] | Direct message to a user who shares a guild with the bot. Fails gracefully when DMs are closed. |
| schedule_message | no | Send Messages | channel, content, send_at, repeat (none, daily, weekly, cron) | Omnicord-side scheduler. Survives restarts. |
| list_scheduled_messages | no | none | guild | Pending scheduled messages. |
| cancel_scheduled_message | yes | none | schedule_id | Cancels a scheduled message. |

## 8. Reactions and polls (7 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| add_reactions | no | Add Reactions | channel, message_id, emojis[] | Adds one or more reactions in a single call. |
| remove_reaction | no | own: none, others': Manage Messages | channel, message_id, emoji, user | Removes a reaction. |
| clear_reactions | yes | Manage Messages | channel, message_id, emoji (optional) | Clears all reactions, or all of one emoji. |
| get_reactions | no | none | channel, message_id, emoji | Who reacted with what. |
| create_poll | no | Send Messages | channel, question, answers[], duration_hours, multi_select | Creates a native Discord poll. |
| get_poll_results | no | none | channel, message_id | Current tallies with percentages. |
| end_poll | no | own polls: none | channel, message_id | Closes a poll early. |

## 9. Roles (10 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_roles * | no | none | guild | Roles with color, position, member count, and a permission digest in plain language. |
| create_role * | no | Manage Roles | guild, name, color, permissions[] or preset (member, moderator, admin), hoist, mentionable, icon | Creates a role. Presets map to vetted permission bundles so the model does not hand out Administrator by reflex. |
| update_role | no | Manage Roles | role, name, color, permissions[], hoist, mentionable, icon | Edits a role. Hierarchy preflighted. |
| delete_role | yes | Manage Roles | role | Deletes a role. Dry run reports member count losing it. |
| clone_role | no | Manage Roles | role, new_name | Copies a role's permissions and settings. |
| reorder_roles | no | Manage Roles | guild, moves[] (role, position) | Batch hierarchy changes. |
| assign_role * | no | Manage Roles | member, role, reason | Gives a member a role. |
| remove_role | no | Manage Roles | member, role, reason | Takes a role from a member. |
| bulk_update_roles | yes | Manage Roles | guild, action (assign, remove), role, filter (has_role, joined_before, joined_after, is_bot) | Fans a role change across all matching members. Dry run returns the member list and count. |
| get_role_members | no | Members intent | role, limit | Members holding a role. |

## 10. Members (7 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| search_members * | no | Members intent | guild, query, role, joined_before, joined_after, is_bot, limit | Finds members by name fragment or filters. |
| list_members | no | Members intent | guild, limit, cursor | Paged member roster. |
| get_member * | no | none | member | Profile: roles, join date, timeout state, voice state, key permissions. |
| update_member | no | varies by field | member, nickname (Manage Nicknames), roles[] (Manage Roles), voice_channel (Move Members), mute, deafen (Mute/Deafen Members) | Multi-field member edit, including moving them between voice channels. |
| get_member_permissions | no | none | member, channel | Effective permissions for a member in a channel, resolved through roles and overwrites, in plain language. |
| disconnect_member | yes | Move Members | member, reason | Kicks a member out of voice. |
| prune_members | yes | Kick Members + Manage Guild | guild, days_inactive, include_roles[] | Removes inactive members. Dry run uses Discord's native prune-count endpoint for an exact preview. |

## 11. Moderation (12 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| timeout_member | yes | Moderate Members | member, duration (up to 28 days), reason | Times a member out. Reason lands in the audit log. |
| remove_timeout | no | Moderate Members | member | Lifts a timeout. |
| kick_member | yes | Kick Members | member, reason | Removes a member. They can rejoin with an invite. |
| ban_member | yes | Ban Members | member or user_id, reason, delete_message_seconds | Bans, optionally deleting recent messages. Works on users no longer in the guild. |
| unban_member | no | Ban Members | user_id, reason | Lifts a ban. |
| bulk_ban | yes | Ban Members + Manage Guild | user_ids[] (up to 200), reason, delete_message_seconds | Mass ban, for raid cleanup. Dry run lists every target. |
| list_bans | no | Ban Members | guild, limit, cursor | Current bans with reasons. |
| list_automod_rules | no | Manage Guild | guild | AutoMod rules, triggers, and actions, summarized. |
| create_automod_rule | no | Manage Guild | guild, name, trigger (keyword, keyword_preset, spam, mention_spam, member_profile), keywords[], regex_patterns[], presets[] (profanity, sexual_content, slurs), allow_list[], mention_limit, actions (block, alert, timeout), alert_channel, timeout_minutes, exempt_roles[], exempt_channels[] | Creates an AutoMod rule. For slur filtering prefer keyword_preset with the slurs preset: Discord maintains the word list. member_profile scans usernames, nicknames, and bios instead of messages and needs a Community server; its block quarantines the member. Timeout is not allowed on spam, keyword_preset, or member_profile rules. |
| update_automod_rule | no | Manage Guild | rule, same fields as create | Edits a rule. |
| delete_automod_rule | yes | Manage Guild | rule | Deletes a rule. |
| set_incident_actions | no | Manage Server | guild, invites (hours to pause, 0 to resume), dms (hours to pause, 0 to resume) | Pauses new invites and DMs between non-friend members for up to 24 hours each, Discord's raid-defense security actions. No arguments reports the current state and any raid Discord detected on its own. |

## 12. Invites (4 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| create_invite | no | Create Invite | channel, max_age, max_uses, temporary, unique | Makes an invite link with explicit lifetime defaults (24h, 0 = infinite must be asked for). |
| list_invites | no | Manage Guild | guild or channel | Active invites with uses and creators. |
| get_invite | no | none | code | Inspects an invite: guild, channel, expiry, use count. |
| delete_invite | yes | Manage Channels | code | Revokes an invite. |

## 13. Webhooks (5 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_webhooks | no | Manage Webhooks | guild or channel | Webhooks with their target channels. Tokens are never returned in summaries. |
| create_webhook | no | Manage Webhooks | channel, name, avatar | Creates a webhook. |
| update_webhook | no | Manage Webhooks | webhook, name, avatar, channel | Edits a webhook. |
| delete_webhook | yes | Manage Webhooks | webhook | Deletes a webhook. |
| send_webhook_message | no | none (token-auth) | webhook, content, username_override, avatar_override, embeds[], thread | Posts via webhook with optional identity override. |

## 14. Expressions: emojis, stickers, soundboard (12 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_emojis | no | none | guild | Custom emojis with usage hints. |
| create_emoji | no | Create Expressions | guild, name, image (URL or file) | Uploads a custom emoji. |
| update_emoji | no | Manage Expressions | emoji, name, roles[] | Renames or role-restricts an emoji. |
| delete_emoji | yes | Manage Expressions | emoji | Deletes an emoji. |
| list_stickers | no | none | guild | Custom stickers. |
| create_sticker | no | Create Expressions | guild, name, description, tags, file | Uploads a sticker. |
| update_sticker | no | Manage Expressions | sticker, name, description, tags | Edits sticker metadata. |
| delete_sticker | yes | Manage Expressions | sticker | Deletes a sticker. |
| list_soundboard_sounds | no | none | guild | Soundboard sounds with volume and emoji. |
| create_soundboard_sound | no | Create Expressions | guild, name, sound (file), volume, emoji | Uploads a soundboard sound. |
| update_soundboard_sound | no | Manage Expressions | sound, name, volume, emoji | Edits a sound. |
| delete_soundboard_sound | yes | Manage Expressions | sound | Deletes a sound. |

## 15. Scheduled events (6 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_events | no | none | guild | Upcoming events with type, time, and interest counts. |
| get_event | no | none | event | One event in detail. |
| create_event | no | Create Events | guild, name, description, type (voice, stage, external), channel or location, start_time, end_time, repeat (daily, weekly, biweekly, monthly), image | Creates a scheduled event, optionally recurring. |
| update_event | no | Manage Events | event, same fields as create, status | Edits or starts an event. |
| cancel_event | yes | Manage Events | event | Cancels an event. |
| get_event_attendees | no | none | event, limit | Users marked interested. |

## 16. Stage instances (4 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_stages | no | none | guild | Live stage instances. |
| start_stage | no | Manage Channels (stage) | channel, topic, privacy, send_notification | Goes live in a stage channel. |
| update_stage | no | Manage Channels (stage) | channel, topic | Changes the live topic. |
| end_stage | yes | Manage Channels (stage) | channel | Ends the stage instance. |

## 17. Application commands and bot (6 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| list_app_commands | no | app owner | guild (optional, else global) | Registered slash commands. |
| register_app_command | no | app owner | name, description, options[], guild | Registers a slash command. |
| update_app_command | no | app owner | command, fields | Edits a command. |
| delete_app_command | yes | app owner | command | Unregisters a command. |
| set_bot_presence | no | none | status (online, idle, dnd, invisible), activity_type, activity_text | Sets the bot's presence. |
| get_bot_info | no | none | (none) | Application info, guild count, enabled intents, library and Omnicord versions. The first diagnostics stop. |

## 18. Builder (10 tools)

The product headline. The flow is: brief in, plan out, plan reviewed, plan executed, with blueprints as the persistence format.

A blueprint is a JSON document describing a complete server: roles (with permission bundles and hierarchy), categories, channels (with types, topics, settings, and overwrites expressed against role names rather than IDs), AutoMod rules, onboarding, welcome screen, scheduled events, and seed content (rules post, pinned welcome, webhooks). Blueprints are portable across guilds because they reference roles by name.

Division of labor, fixed at implementation time: the AI client owns the creative translation from conversation to blueprint (themes, naming, which channels a "dark fantasy guild" needs), guided by the reference layouts. Omnicord owns correctness: schema validation, intra-blueprint and live-server collision detection, Discord structural limits, role reference resolution, Community feature gating (verified against the live API: forums work everywhere, announcement and stage channels need Community), bot permission preflight, and dependency ordering. This keeps every deployment free of any LLM dependency inside the server itself. Visibility sugar on channels and categories: private_to (role names that can see it), read_only, and posting_roles compile to permission overwrites at execution.

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| plan_server_build * | no | none | guild, blueprint (structured; the client AI composes it from the user's request, optionally starting from a reference layout) | Validates the blueprint against the live server and stages an ordered build plan. Makes no changes. Reports every problem at once (collisions, limits, bad role references, feature gates, missing bot permissions); existing entities with matching names are reused, never duplicated. |
| execute_build_plan * | no (additive) | aggregate of the plan's needs, typically Manage Channels + Manage Roles | guild, plan_id or blueprint | Executes a plan. The blueprint is re-validated against live server state at execution time, so staged plans can never act on stale data. Strictly additive in v1: existing entities are reused, nothing is deleted or modified; visibility sugar compiles to permission overwrites at creation, and the bot always grants itself access to what it builds. Runs in dependency order (roles, categories, channels), halts on failure with a created/failed/not-attempted report, and re-running after a fix resumes naturally through reuse. Reconcile mode (destructive, drift-correcting) is deferred to the diff_blueprint work. |
| list_reference_layouts | no | none | (none) | Curated server archetypes shipped with Omnicord: gaming community, product support, creator community, study group, esports org, internal team. Each is a vetted blueprint with rationale notes. |
| get_reference_layout | no | none | layout_id | One archetype in full, with commentary on why its structure works. |
| export_server_blueprint | no | none | guild, save_as | Snapshots a live guild into a blueprint, decompiling permission overwrites back into the visibility sugar where they fit and warning where they do not. Seed content capture is not part of the export yet. |
| save_blueprint | no | none | name, blueprint, description | Saves a blueprint to the Omnicord store. |
| list_blueprints | no | none | (none) | Saved blueprints with names and dates. |
| get_blueprint | no | none | blueprint_id | One saved blueprint. |
| delete_blueprint | yes | none | blueprint_id | Deletes a saved blueprint. |
| diff_blueprint | no | none | guild, blueprint_id | Drift report: how the live server differs from a blueprint (missing channels, changed permissions, renamed roles). The basis for reconcile mode and for config-as-code workflows. |

## 19. Events and notifications (4 tools)

Real-time gateway events surfaced through MCP. No notable competitor ships this.

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| subscribe_events | no | intents vary by type | guild, types[] (message_created, member_joined, member_left, reaction_added, channel_created, role_changed, ban_added, voice_state_changed), channel_filter, delivery (notification, buffer) | Subscribes to gateway events. Notification delivery pushes MCP notifications; buffer delivery stores events for polling. |
| unsubscribe_events | no | none | subscription_id | Ends a subscription. |
| list_event_subscriptions | no | none | guild | Active subscriptions. |
| get_recent_events | no | none | subscription_id, limit, cursor | Drains buffered events, for clients that cannot receive notifications. |

## 20. Diagnostics and utility (4 tools)

| Tool | D | Requires | Key parameters | Summary |
|---|---|---|---|---|
| run_setup_check * | no | none | guild (optional) | End-to-end health check: token presence and validity, the three privileged intents (enabled in the portal versus needed), guild count against the verification gate, gateway connection, and default-guild membership. Output is a plain-English pass or fix list. Run on first connect and whenever things act weird. |
| explain_permissions | no | none | actor (bot or member), action, channel | Answers "can X do Y in Z, and if not, why not" by resolving the full permission chain. The preflight engine, exposed. |
| get_rate_limit_status | no | none | (none) | Current bucket states, queue depth, and invalid-request counter. |
| find * | no | none | query, types[] (channel, role, member, emoji, thread, event), guild | The fuzzy resolver as a tool. Returns ranked candidates with IDs and context so the caller can disambiguate once and reuse the ID. |

## 21. Explicit non-goals

- Voice audio (play, capture, transcribe). Planned v2 flagship; blocked on DAVE E2EE work.
- Acting as a user account in any form. Self-bot patterns violate Discord ToS and will never ship.
- Guild creation from nothing (`create_server`). Deferred; requires the dedicated builder-bot model due to the under-10-guilds API restriction.
- Monetization endpoints (SKUs, entitlements), Activities, and the Social SDK surface.
- Training any model on message content obtained through the API (Developer Policy rule 21). Runtime inference only.

## 22. Open questions

1. Blueprint schema versioning: semver the format, or stay loose for now.
