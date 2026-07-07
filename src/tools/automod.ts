import { z } from "zod";
import {
  Routes,
  PermissionFlagsBits,
  AutoModerationRuleTriggerType,
  AutoModerationRuleEventType,
  AutoModerationActionType,
  AutoModerationRuleKeywordPresetType,
} from "discord-api-types/v10";
import type { APIAutoModerationRule } from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { resolveOne } from "../discord/resolve.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  ToolProblem,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
} from "./common.js";

// AutoMod: Discord's server-side automatic moderation rules. These run on
// Discord's infrastructure, so they keep working when Omnicord is offline.

const P = PermissionFlagsBits;

const TRIGGER_LABELS: Record<number, string> = {
  [AutoModerationRuleTriggerType.Keyword]: "keyword",
  [AutoModerationRuleTriggerType.Spam]: "spam",
  [AutoModerationRuleTriggerType.KeywordPreset]: "keyword_preset",
  [AutoModerationRuleTriggerType.MentionSpam]: "mention_spam",
  [AutoModerationRuleTriggerType.MemberProfile]: "member_profile",
};

const ACTION_LABELS: Record<number, string> = {
  [AutoModerationActionType.BlockMessage]: "block",
  [AutoModerationActionType.SendAlertMessage]: "alert",
  [AutoModerationActionType.Timeout]: "timeout",
};

// Discord-maintained preset word lists for keyword_preset rules. Discord
// owns and updates the lists server-side, so no keyword list ever needs
// to be supplied (or generated) for these categories.
const PRESET_VALUES: Record<string, AutoModerationRuleKeywordPresetType> = {
  profanity: AutoModerationRuleKeywordPresetType.Profanity,
  sexual_content: AutoModerationRuleKeywordPresetType.SexualContent,
  slurs: AutoModerationRuleKeywordPresetType.Slurs,
};

const PRESET_LABELS: Record<number, string> = {
  [AutoModerationRuleKeywordPresetType.Profanity]: "profanity",
  [AutoModerationRuleKeywordPresetType.SexualContent]: "sexual_content",
  [AutoModerationRuleKeywordPresetType.Slurs]: "slurs",
};

function ruleDigest(rule: APIAutoModerationRule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger: TRIGGER_LABELS[rule.trigger_type] ?? `type ${rule.trigger_type}`,
    keywords: rule.trigger_metadata?.keyword_filter ?? [],
    regex_patterns: rule.trigger_metadata?.regex_patterns ?? [],
    presets: (rule.trigger_metadata?.presets ?? []).map(
      (p) => PRESET_LABELS[p] ?? `type ${p}`
    ),
    allow_list: rule.trigger_metadata?.allow_list ?? [],
    mention_limit: rule.trigger_metadata?.mention_total_limit ?? null,
    actions: rule.actions.map((a) => ACTION_LABELS[a.type] ?? `type ${a.type}`),
    exempt_roles: rule.exempt_roles ?? [],
    exempt_channels: rule.exempt_channels ?? [],
  };
}

async function fetchRules(
  rest: REST,
  guildId: string
): Promise<APIAutoModerationRule[]> {
  return (await rest.get(
    Routes.guildAutoModerationRules(guildId)
  )) as APIAutoModerationRule[];
}

async function resolveRule(
  rest: REST,
  guildId: string,
  query: string
): Promise<APIAutoModerationRule> {
  const rules = await fetchRules(rest, guildId);
  const resolution = resolveOne(
    query,
    rules.map((r) => ({ id: r.id, name: r.name, type: "automod rule" }))
  );
  if ("match" in resolution) {
    const rule = rules.find((r) => r.id === resolution.match.id);
    if (rule) return rule;
  }
  const candidates = "candidates" in resolution ? resolution.candidates : [];
  throw new ToolProblem(
    candidates.length === 0
      ? fail(`No AutoMod rule matching "${query}".`)
      : fail(`Multiple rules match "${query}". Pick one by ID.`, { candidates })
  );
}

export function registerAutomodTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "list_automod_rules",
    {
      title: "List AutoMod rules",
      description: "Server-side automatic moderation rules and what they do.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const rules = await fetchRules(rest, guildId);
      return ok(`${rules.length} AutoMod rule(s).`, {
        rules: rules.map(ruleDigest),
      });
    })
  );

  server.registerTool(
    "create_automod_rule",
    {
      title: "Create AutoMod rule",
      description:
        "Create a server-side moderation rule that runs on Discord's own " +
        "infrastructure: Discord-maintained preset word lists (slurs, " +
        "profanity, sexual content), custom keyword filters (with optional " +
        "regex), spam detection, mention-flood limits, or member_profile " +
        "checks on usernames, nicknames, and bios (Community servers only). " +
        "For slur or " +
        "hate-speech filtering prefer trigger keyword_preset with the " +
        "slurs preset: Discord maintains the word list, so none needs to " +
        "be written. Actions: block the message, alert a channel, and/or " +
        "time the sender out (timeout is not available on spam, " +
        "keyword_preset, or member_profile rules). On member_profile rules " +
        "block quarantines the member until they fix their profile.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(1).max(100),
        trigger: z.enum(["keyword", "keyword_preset", "spam", "mention_spam", "member_profile"]),
        keywords: z.array(z.string().max(60)).max(1000).optional()
          .describe("For keyword rules. Wildcards: word* matches prefixes."),
        regex_patterns: z.array(z.string().max(260)).max(10).optional()
          .describe("For keyword rules; Rust-flavored regex."),
        presets: z.array(z.enum(["profanity", "sexual_content", "slurs"]))
          .min(1).max(3).optional()
          .describe("For keyword_preset rules: Discord-maintained lists."),
        allow_list: z.array(z.string().max(60)).max(1000).optional()
          .describe("Words exempt from keyword and keyword_preset rules."),
        mention_limit: z.number().int().min(1).max(50).optional()
          .describe("For mention_spam rules: max unique mentions per message."),
        actions: z.array(z.enum(["block", "alert", "timeout"])).min(1)
          .describe("What happens on a match."),
        alert_channel: z.string().optional()
          .describe("Where alert actions post."),
        timeout_minutes: z.number().int().min(1).max(40320).optional()
          .describe("How long timeout actions last."),
        exempt_roles: z.array(z.string()).max(20).optional(),
        exempt_channels: z.array(z.string()).max(50).optional(),
        enabled: z.boolean().optional().describe("Default true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      guild,
      name,
      trigger,
      keywords,
      regex_patterns,
      presets,
      allow_list,
      mention_limit,
      actions,
      alert_channel,
      timeout_minutes,
      exempt_roles,
      exempt_channels,
      enabled,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      if (trigger === "keyword" && !keywords?.length && !regex_patterns?.length) {
        return fail("Keyword rules need keywords or regex_patterns.");
      }
      if (trigger === "keyword_preset" && !presets?.length) {
        return fail(
          "keyword_preset rules need presets: profanity, sexual_content, " +
            "and/or slurs."
        );
      }
      if (presets?.length && trigger !== "keyword_preset") {
        return fail("presets only apply to keyword_preset rules.");
      }
      if (trigger === "keyword_preset" && (keywords?.length || regex_patterns?.length)) {
        return fail(
          "keyword_preset rules use Discord's own word lists; pass " +
            "allow_list to exempt words, not keywords or regex_patterns."
        );
      }
      if (trigger === "mention_spam" && !mention_limit) {
        return fail("mention_spam rules need a mention_limit.");
      }
      if (trigger === "member_profile" && !keywords?.length && !regex_patterns?.length) {
        return fail(
          "member_profile rules need keywords or regex_patterns to match " +
            "against member profiles."
        );
      }
      if (actions.includes("alert") && !alert_channel) {
        return fail("The alert action needs an alert_channel.");
      }
      if (actions.includes("timeout") && !timeout_minutes) {
        return fail("The timeout action needs timeout_minutes.");
      }
      if (actions.includes("timeout") && trigger === "spam") {
        return fail("Discord does not allow timeout actions on spam rules.");
      }
      if (actions.includes("timeout") && trigger === "keyword_preset") {
        return fail(
          "Discord does not allow timeout actions on keyword_preset rules; " +
            "use block and/or alert."
        );
      }
      if (actions.includes("timeout") && trigger === "member_profile") {
        return fail(
          "Discord does not allow timeout on member_profile rules; use block " +
            "to quarantine the member, or alert."
        );
      }

      const builtActions: Array<Record<string, unknown>> = [];
      for (const action of actions) {
        if (action === "block") {
          builtActions.push({
            type:
              trigger === "member_profile"
                ? AutoModerationActionType.BlockMemberInteraction
                : AutoModerationActionType.BlockMessage,
          });
        } else if (action === "alert") {
          const channel = await resolveChannel(
            rest,
            guildId,
            alert_channel as string,
            TEXT_BEARING_TYPES
          );
          builtActions.push({
            type: AutoModerationActionType.SendAlertMessage,
            metadata: { channel_id: channel.id },
          });
        } else {
          builtActions.push({
            type: AutoModerationActionType.Timeout,
            metadata: { duration_seconds: (timeout_minutes as number) * 60 },
          });
        }
      }

      const triggerType =
        trigger === "keyword"
          ? AutoModerationRuleTriggerType.Keyword
          : trigger === "keyword_preset"
            ? AutoModerationRuleTriggerType.KeywordPreset
            : trigger === "spam"
              ? AutoModerationRuleTriggerType.Spam
              : trigger === "mention_spam"
                ? AutoModerationRuleTriggerType.MentionSpam
                : AutoModerationRuleTriggerType.MemberProfile;

      const rule = (await rest.post(Routes.guildAutoModerationRules(guildId), {
        body: {
          name,
          event_type:
            trigger === "member_profile"
              ? AutoModerationRuleEventType.MemberUpdate
              : AutoModerationRuleEventType.MessageSend,
          trigger_type: triggerType,
          trigger_metadata: {
            ...(keywords?.length ? { keyword_filter: keywords } : {}),
            ...(regex_patterns?.length ? { regex_patterns } : {}),
            ...(presets?.length
              ? { presets: presets.map((p) => PRESET_VALUES[p]) }
              : {}),
            ...(allow_list?.length ? { allow_list } : {}),
            ...(mention_limit ? { mention_total_limit: mention_limit } : {}),
          },
          actions: builtActions,
          enabled: enabled ?? true,
          ...(exempt_roles?.length ? { exempt_roles } : {}),
          ...(exempt_channels?.length ? { exempt_channels } : {}),
        },
        reason: "Created via Omnicord",
      })) as APIAutoModerationRule;

      return ok(
        `AutoMod rule "${rule.name}" is live: ${trigger} trigger, ` +
          `${actions.join(" + ")} action(s). It runs on Discord's side ` +
          "around the clock.",
        ruleDigest(rule)
      );
    })
  );

  server.registerTool(
    "update_automod_rule",
    {
      title: "Update AutoMod rule",
      description:
        "Rename a rule, enable or disable it, or replace its keyword list.",
      inputSchema: {
        rule: z.string().describe("Rule name or ID."),
        guild: guildParam,
        name: z.string().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        keywords: z.array(z.string().max(60)).max(1000).optional()
          .describe("Replaces the keyword list on keyword rules."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ rule, guild, name, enabled, keywords }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const found = await resolveRule(rest, guildId, rule);
      const changes: string[] = [];
      if (name !== undefined) changes.push(`name to "${name}"`);
      if (enabled !== undefined) changes.push(enabled ? "enabled" : "disabled");
      if (keywords !== undefined) {
        if (found.trigger_type !== AutoModerationRuleTriggerType.Keyword) {
          return fail("Only keyword rules carry a keyword list.");
        }
        changes.push(`${keywords.length} keyword(s)`);
      }
      if (changes.length === 0) return fail("Pass at least one field to change.");

      const updated = (await rest.patch(
        Routes.guildAutoModerationRule(guildId, found.id),
        {
          body: {
            ...(name !== undefined ? { name } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
            ...(keywords !== undefined
              ? {
                  trigger_metadata: {
                    ...found.trigger_metadata,
                    keyword_filter: keywords,
                  },
                }
              : {}),
          },
          reason: "Updated via Omnicord",
        }
      )) as APIAutoModerationRule;

      return ok(`Updated the rule "${updated.name}": ${changes.join(", ")}.`, ruleDigest(updated));
    })
  );

  server.registerTool(
    "delete_automod_rule",
    {
      title: "Delete AutoMod rule",
      description:
        "Delete an AutoMod rule; its protection stops immediately. Safe " +
        "to call directly: the first call changes nothing and returns a " +
        "preview plus a confirm_token; repeating the call with the token " +
        "deletes it. Disabling is the reversible alternative.",
      inputSchema: {
        rule: z.string().describe("Rule name or ID."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ rule, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const found = await resolveRule(rest, guildId, rule);
      const gate = gateDestructive({
        tool: "delete_automod_rule",
        args: { rule: found.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the AutoMod rule "${found.name}" ` +
          `(${TRIGGER_LABELS[found.trigger_type]}); its protection stops ` +
          "immediately. Disabling it instead is reversible.",
        previewDetails: ruleDigest(found),
      });
      if (gate) return gate;

      await rest.delete(Routes.guildAutoModerationRule(guildId, found.id), {
        reason: "Deleted via Omnicord",
      });
      return ok(`Deleted the AutoMod rule "${found.name}".`, {
        deleted: true,
        id: found.id,
      });
    })
  );
}
