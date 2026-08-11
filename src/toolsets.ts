// Toolsets: which tools a session exposes.
//
// Every tool definition a client loads costs context before the user types
// anything, and a large tool surface measurably hurts tool selection. The full
// set is around 120 KB of JSON, so an operator who only wants chat and
// moderation should not have to carry the builder, forum, and soundboard
// schemas as well.
//
// OMNICORD_TOOLS selects groups by name. Unset means every group, so an
// existing install behaves exactly as it did before. The core group is always
// present: without diagnostics and the read tools the server cannot answer
// "which servers am I in" or "did my setup work", which makes every other
// group harder to use.
//
// Groups are assigned per tool rather than per source file on purpose. The
// files are organised by implementation concern, not by user intent:
// write.ts holds send_message next to create_channel, and manage.ts holds
// edit_message next to delete_role. Grouping by file would produce sets no
// operator would recognise.

// Always registered. Diagnostics, the server roster, and the read surface.
const CORE = [
  "get_rate_limit_status",
  "get_bot_info",
  "run_setup_check",
  "list_servers",
  "list_members",
  "get_role_members",
  "get_server_overview",
  "list_channels",
  "list_roles",
  "read_messages",
  "search_messages",
  "search_members",
  "get_member",
  "find",
] as const;

// Optional groups, selected by name.
const OPTIONAL: Record<string, readonly string[]> = {
  // Everyday chat: sending, editing, reactions, polls, pins, scheduling.
  messaging: [
    "send_message",
    "forward_message",
    "delete_message",
    "get_message",
    "send_dm",
    "bulk_delete_messages",
    "crosspost_message",
    "schedule_message",
    "list_scheduled_messages",
    "cancel_scheduled_message",
    "edit_message",
    "pin_message",
    "unpin_message",
    "list_pinned_messages",
    "add_reactions",
    "remove_reaction",
    "clear_reactions",
    "get_reactions",
    "create_poll",
    "get_poll_results",
    "end_poll",
  ],

  // Acting on members: bans, kicks, timeouts, automod, the audit log.
  moderation: [
    "timeout_member",
    "remove_timeout",
    "kick_member",
    "ban_member",
    "unban_member",
    "bulk_ban",
    "list_bans",
    "get_audit_log",
    "set_incident_actions",
    "update_member",
    "disconnect_member",
    "list_voice_members",
    "prune_members",
    "list_automod_rules",
    "create_automod_rule",
    "update_automod_rule",
    "delete_automod_rule",
  ],

  // The shape of the server: channels, roles, and permission overwrites.
  structure: [
    "create_channel",
    "update_channel",
    "delete_channel",
    "get_channel",
    "clone_channel",
    "reorder_channels",
    "follow_announcement_channel",
    "set_voice_channel_status",
    "create_role",
    "update_role",
    "delete_role",
    "clone_role",
    "reorder_roles",
    "bulk_update_roles",
    "assign_role",
    "remove_role",
    "get_member_permissions",
    "get_channel_permissions",
    "set_channel_permissions",
    "clear_channel_permissions",
    "lock_channel",
    "unlock_channel",
    "explain_permissions",
  ],

  // Building a server from a brief, and blueprints as the persistence format.
  builder: [
    "list_reference_layouts",
    "get_reference_layout",
    "plan_server_build",
    "execute_build_plan",
    "save_blueprint",
    "list_blueprints",
    "get_blueprint",
    "delete_blueprint",
    "export_server_blueprint",
    "diff_blueprint",
  ],

  threads: [
    "create_thread",
    "list_threads",
    "get_thread",
    "update_thread",
    "delete_thread",
    "list_thread_members",
    "add_thread_member",
    "remove_thread_member",
  ],

  forums: [
    "create_forum_post",
    "list_forum_posts",
    "reply_to_forum_post",
    "update_forum_post",
    "delete_forum_post",
    "create_forum_tag",
    "update_forum_tag",
    "delete_forum_tag",
  ],

  // Things a community uses day to day: invites, webhooks, events, stages,
  // and the expression sets (emojis, stickers, soundboard).
  community: [
    "create_invite",
    "list_invites",
    "get_invite",
    "delete_invite",
    "list_webhooks",
    "create_webhook",
    "update_webhook",
    "delete_webhook",
    "send_webhook_message",
    "list_emojis",
    "create_emoji",
    "update_emoji",
    "delete_emoji",
    "list_events",
    "get_event",
    "create_event",
    "update_event",
    "cancel_event",
    "get_event_attendees",
    "list_stages",
    "start_stage",
    "update_stage",
    "end_stage",
    "list_stickers",
    "create_sticker",
    "update_sticker",
    "delete_sticker",
    "list_soundboard_sounds",
    "create_soundboard_sound",
    "update_soundboard_sound",
    "delete_soundboard_sound",
  ],

  // Server-wide settings and the application itself: the guild, onboarding,
  // templates, presence, and the bot's slash commands.
  server: [
    "list_app_commands",
    "register_app_command",
    "update_app_command",
    "delete_app_command",
    "update_server",
    "get_server_preview",
    "get_server_widget",
    "update_server_widget",
    "get_welcome_screen",
    "update_welcome_screen",
    "get_onboarding",
    "update_onboarding",
    "list_integrations",
    "delete_integration",
    "list_server_templates",
    "create_server_template",
    "sync_server_template",
    "delete_server_template",
    "set_bot_presence",
  ],

  // Live gateway events.
  realtime: [
    "subscribe_events",
    "get_recent_events",
    "list_event_subscriptions",
    "unsubscribe_events",
  ],
};

export const CORE_TOOLS: readonly string[] = CORE;
export const TOOLSETS: Readonly<Record<string, readonly string[]>> = OPTIONAL;
export const TOOLSET_NAMES: readonly string[] = Object.keys(OPTIONAL).sort();

export interface ToolsetSelection {
  // Group names that were selected, excluding core.
  groups: string[];
  // Every tool name to register, core included.
  tools: Set<string>;
  // Names in the setting that match no group. Non-empty means bad input.
  unknown: string[];
  // True when the setting was absent or "all", meaning no filtering.
  all: boolean;
}

// Resolves the OMNICORD_TOOLS setting. Pure, so the unit suite can cover
// every branch without touching the environment.
//
// Unset, empty, or "all" selects everything. Otherwise the value is a comma
// separated list of group names; core is added whether or not it is listed.
// Unknown names are collected rather than ignored so the caller can refuse to
// start and say which names were wrong.
export function selectToolsets(raw: string | undefined): ToolsetSelection {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") {
    const tools = new Set<string>(CORE);
    for (const names of Object.values(OPTIONAL)) for (const n of names) tools.add(n);
    return { groups: [...TOOLSET_NAMES], tools, unknown: [], all: true };
  }

  const requested = trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const groups: string[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    if (name === "core") continue; // always on, listing it is harmless
    if (Object.prototype.hasOwnProperty.call(OPTIONAL, name)) {
      if (!groups.includes(name)) groups.push(name);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }

  const tools = new Set<string>(CORE);
  for (const g of groups) for (const n of OPTIONAL[g]) tools.add(n);
  return { groups, tools, unknown, all: false };
}

// The message shown when OMNICORD_TOOLS names a group that does not exist.
// Startup fails rather than silently exposing a smaller surface than the
// operator asked for, which would look like tools going missing at random.
export function unknownToolsetMessage(unknown: string[]): string {
  const plural = unknown.length === 1 ? "group" : "groups";
  return (
    `OMNICORD_TOOLS names unknown ${plural}: ${unknown.join(", ")}. ` +
    `Valid groups are: ${TOOLSET_NAMES.join(", ")}. ` +
    `The core group is always enabled. Leave OMNICORD_TOOLS unset for every tool.`
  );
}
