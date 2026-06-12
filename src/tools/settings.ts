import { z } from "zod";
import { Routes, PermissionFlagsBits } from "discord-api-types/v10";
import type {
  APIGuild,
  APIGuildIntegration,
  APIGuildPreview,
  APIGuildWelcomeScreen,
  APITemplate,
} from "discord-api-types/v10";
import { DiscordAPIError } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { setPresence } from "../discord/gateway.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import {
  enter,
  guarded,
  guildParam,
  resolveChannel,
  TEXT_BEARING_TYPES,
  botPermissions,
  requirePermissions,
} from "./common.js";

// Guild settings: identity, widget, welcome screen, onboarding,
// integrations, templates, pruning, and the bot's own presence.

const P = PermissionFlagsBits;

const VERIFICATION_LEVELS: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  very_high: 4,
};

function templateDigest(t: APITemplate) {
  return {
    code: t.code,
    name: t.name,
    description: t.description ?? null,
    usage_count: t.usage_count,
    out_of_sync: t.is_dirty ?? false,
    updated_at: t.updated_at,
  };
}

// Welcome screens only exist on Community servers; the raw 403/404 from
// Discord is unhelpful, so both read and write translate it.
function welcomeScreenProblem(err: unknown): string | null {
  if (err instanceof DiscordAPIError && (err.status === 404 || err.status === 403)) {
    return (
      "This server has no welcome screen. Discord only offers one on " +
      "Community servers (Server Settings, Enable Community)."
    );
  }
  return null;
}

export function registerSettingsTools(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "update_server",
    {
      title: "Update server",
      description:
        "Edit server settings: name, description, AFK behavior, system " +
        "and rules channels, verification level. Only passed fields " +
        "change. Descriptions need a Community server.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(2).max(100).optional(),
        description: z.string().max(300).optional(),
        verification_level: z
          .enum(["none", "low", "medium", "high", "very_high"])
          .optional(),
        afk_timeout_seconds: z
          .union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)])
          .optional(),
        afk_channel: z.string().optional()
          .describe("Voice channel name or ID, or none to clear."),
        system_channel: z.string().optional()
          .describe("Channel for join notices, or none to clear."),
        community: z.boolean().optional()
          .describe(
            "Enable or disable the Community feature. Enabling needs " +
            "rules_channel and public_updates_channel."
          ),
        rules_channel: z.string().optional()
          .describe("Text channel for the rules, when enabling Community."),
        public_updates_channel: z.string().optional()
          .describe("Text channel for Discord's mod updates, when enabling Community."),
        dry_run: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({
      guild,
      name,
      description,
      verification_level,
      afk_timeout_seconds,
      afk_channel,
      system_channel,
      community,
      rules_channel,
      public_updates_channel,
      dry_run,
    }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const changes: string[] = [];
      const body: Record<string, unknown> = {};

      // The Community feature is toggled through the features array and
      // carries prerequisites Discord enforces: a rules channel, a public
      // updates channel, members-only notifications, full content
      // filtering, and at least low verification.
      if (community !== undefined) {
        const current = (await rest.get(Routes.guild(guildId))) as APIGuild;
        if (community) {
          if (!rules_channel || !public_updates_channel) {
            return fail(
              "Enabling Community needs rules_channel and " +
                "public_updates_channel (text channels)."
            );
          }
          const rules = await resolveChannel(rest, guildId, rules_channel, [0]);
          const updates = await resolveChannel(
            rest,
            guildId,
            public_updates_channel,
            [0]
          );
          body.features = [...new Set([...current.features, "COMMUNITY"])];
          body.rules_channel_id = rules.id;
          body.public_updates_channel_id = updates.id;
          body.explicit_content_filter = 2;
          body.default_message_notifications = 1;
          if (current.verification_level < 1) body.verification_level = 1;
          changes.push("Community enabled");
        } else {
          body.features = current.features.filter((f) => f !== "COMMUNITY");
          changes.push("Community disabled");
        }
      }
      if (name !== undefined) {
        body.name = name;
        changes.push(`name to "${name}"`);
      }
      if (description !== undefined) {
        body.description = description;
        changes.push("description");
      }
      if (verification_level !== undefined) {
        body.verification_level = VERIFICATION_LEVELS[verification_level];
        changes.push(`verification to ${verification_level}`);
      }
      if (afk_timeout_seconds !== undefined) {
        body.afk_timeout = afk_timeout_seconds;
        changes.push(`afk timeout to ${afk_timeout_seconds}s`);
      }
      if (afk_channel !== undefined) {
        if (afk_channel.toLowerCase() === "none") {
          body.afk_channel_id = null;
          changes.push("afk channel cleared");
        } else {
          const target = await resolveChannel(rest, guildId, afk_channel, [2]);
          body.afk_channel_id = target.id;
          changes.push(`afk channel to ${target.name}`);
        }
      }
      if (system_channel !== undefined) {
        if (system_channel.toLowerCase() === "none") {
          body.system_channel_id = null;
          changes.push("system channel cleared");
        } else {
          const target = await resolveChannel(rest, guildId, system_channel, [0]);
          body.system_channel_id = target.id;
          changes.push(`system channel to #${target.name}`);
        }
      }
      if (changes.length === 0) return fail("Pass at least one field to change.");

      if (dry_run) {
        return ok(
          `Dry run: would change ${changes.join(", ")}. Nothing was changed.`,
          { executed: false }
        );
      }

      const updated = (await rest.patch(Routes.guild(guildId), {
        body,
        reason: "Updated via Omnicord",
      })) as APIGuild;
      return ok(`Updated the server: ${changes.join(", ")}.`, {
        id: updated.id,
        name: updated.name,
        changed: changes,
      });
    })
  );

  server.registerTool(
    "get_server_preview",
    {
      title: "Get server preview",
      description:
        "A server's preview: name, description, and approximate member " +
        "counts. Works for servers the bot is in; other servers need to " +
        "be discoverable.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      try {
        const preview = (await rest.get(
          Routes.guildPreview(guildId)
        )) as APIGuildPreview;
        return ok(
          `${preview.name}: about ${preview.approximate_member_count} members.`,
          {
            id: preview.id,
            name: preview.name,
            description: preview.description ?? null,
            members_approximate: preview.approximate_member_count,
            online_approximate: preview.approximate_presence_count,
          }
        );
      } catch (err) {
        if (err instanceof DiscordAPIError && err.status === 404) {
          return fail(
            "This server has no public preview; previews exist only for " +
              "discoverable servers."
          );
        }
        throw err;
      }
    })
  );

  server.registerTool(
    "get_server_widget",
    {
      title: "Get server widget",
      description: "Widget settings: enabled state and invite channel.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const widget = (await rest.get(Routes.guildWidgetSettings(guildId))) as {
        enabled: boolean;
        channel_id: string | null;
      };
      return ok(
        `Widget is ${widget.enabled ? "enabled" : "disabled"}.`,
        widget
      );
    })
  );

  server.registerTool(
    "update_server_widget",
    {
      title: "Update server widget",
      description: "Enable or disable the widget, or point its invite channel.",
      inputSchema: {
        guild: guildParam,
        enabled: z.boolean().optional(),
        channel: z.string().optional()
          .describe("Invite channel name or ID, or none to clear."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, enabled, channel }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");
      if (enabled === undefined && channel === undefined) {
        return fail("Pass enabled or channel to change.");
      }

      let channelId: string | null | undefined;
      if (channel !== undefined) {
        channelId =
          channel.toLowerCase() === "none"
            ? null
            : (await resolveChannel(rest, guildId, channel)).id;
      }

      const widget = (await rest.patch(Routes.guildWidgetSettings(guildId), {
        body: {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(channelId !== undefined ? { channel_id: channelId } : {}),
        },
        reason: "Updated via Omnicord",
      })) as { enabled: boolean; channel_id: string | null };

      return ok(
        `Widget is now ${widget.enabled ? "enabled" : "disabled"}.`,
        widget
      );
    })
  );

  server.registerTool(
    "get_welcome_screen",
    {
      title: "Get welcome screen",
      description: "The Community welcome screen, when the server has one.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      try {
        const screen = (await rest.get(
          Routes.guildWelcomeScreen(guildId)
        )) as APIGuildWelcomeScreen;
        return ok(
          `Welcome screen with ${screen.welcome_channels.length} channel card(s).`,
          {
            description: screen.description ?? null,
            channels: screen.welcome_channels.map((c) => ({
              channel_id: c.channel_id,
              description: c.description,
            })),
          }
        );
      } catch (err) {
        const problem = welcomeScreenProblem(err);
        if (problem) return fail(problem);
        throw err;
      }
    })
  );

  server.registerTool(
    "update_welcome_screen",
    {
      title: "Update welcome screen",
      description:
        "Edit the Community welcome screen: the description and up to " +
        "five channel cards.",
      inputSchema: {
        guild: guildParam,
        enabled: z.boolean().optional(),
        description: z.string().max(140).optional(),
        channels: z
          .array(
            z.object({
              channel: z.string(),
              description: z.string().min(1).max(50),
            })
          )
          .max(5)
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, enabled, description, channels }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");
      if (enabled === undefined && description === undefined && channels === undefined) {
        return fail("Pass at least one field to change.");
      }

      let welcomeChannels:
        | Array<{ channel_id: string; description: string; emoji_id: null; emoji_name: null }>
        | undefined;
      if (channels) {
        welcomeChannels = [];
        for (const entry of channels) {
          const target = await resolveChannel(rest, guildId, entry.channel, TEXT_BEARING_TYPES);
          welcomeChannels.push({
            channel_id: target.id,
            description: entry.description,
            emoji_id: null,
            emoji_name: null,
          });
        }
      }

      try {
        await rest.patch(Routes.guildWelcomeScreen(guildId), {
          body: {
            ...(enabled !== undefined ? { enabled } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(welcomeChannels !== undefined
              ? { welcome_channels: welcomeChannels }
              : {}),
          },
          reason: "Updated via Omnicord",
        });
      } catch (err) {
        const problem = welcomeScreenProblem(err);
        if (problem) return fail(problem);
        throw err;
      }
      return ok("Updated the welcome screen.", { updated: true });
    })
  );

  server.registerTool(
    "get_onboarding",
    {
      title: "Get onboarding",
      description: "The new-member onboarding flow, when configured.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const onboarding = (await rest.get(Routes.guildOnboarding(guildId))) as {
        enabled: boolean;
        prompts: Array<{ title: string; options: unknown[] }>;
        default_channel_ids: string[];
      };
      return ok(
        `Onboarding is ${onboarding.enabled ? "enabled" : "disabled"} with ` +
          `${onboarding.prompts.length} prompt(s).`,
        {
          enabled: onboarding.enabled,
          prompts: onboarding.prompts.map((p) => ({
            title: p.title,
            options: p.options.length,
          })),
          default_channel_ids: onboarding.default_channel_ids,
        }
      );
    })
  );

  server.registerTool(
    "update_onboarding",
    {
      title: "Update onboarding",
      description:
        "Configure the new-member onboarding flow on a Community server: " +
        "prompts with options that grant channels and roles, the default " +
        "channels every member sees, and the enabled state. Discord's app " +
        "asks for at least seven default channels when configuring this " +
        "by hand; the API has been observed to accept fewer.",
      inputSchema: {
        guild: guildParam,
        enabled: z.boolean().optional(),
        mode: z.enum(["default", "advanced"]).optional()
          .describe(
            "default counts only default channels toward the constraints; " +
            "advanced counts prompt option channels too."
          ),
        default_channels: z.array(z.string()).max(50).optional()
          .describe("Channel names or IDs every new member gets."),
        prompts: z
          .array(
            z.object({
              title: z.string().min(1).max(100),
              type: z.enum(["multiple_choice", "dropdown"]).optional()
                .describe("Default multiple_choice."),
              required: z.boolean().optional(),
              single_select: z.boolean().optional(),
              options: z
                .array(
                  z.object({
                    title: z.string().min(1).max(50),
                    description: z.string().max(100).optional(),
                    channels: z.array(z.string()).optional()
                      .describe("Channels this option grants."),
                    roles: z.array(z.string()).optional()
                      .describe("Roles this option grants."),
                  })
                )
                .min(1)
                .max(50),
            })
          )
          .max(15)
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, enabled, mode, default_channels, prompts }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [
          [P.ManageGuild, "Manage Server"],
          [P.ManageRoles, "Manage Roles"],
          [P.ManageChannels, "Manage Channels"],
        ],
        "in this server"
      );
      if (
        enabled === undefined &&
        mode === undefined &&
        default_channels === undefined &&
        prompts === undefined
      ) {
        return fail("Pass at least one field to change.");
      }

      // Names resolve to IDs up front so a typo fails the whole call
      // instead of producing a half-configured flow.
      let defaultChannelIds: string[] | undefined;
      if (default_channels) {
        defaultChannelIds = [];
        for (const entry of default_channels) {
          defaultChannelIds.push((await resolveChannel(rest, guildId, entry)).id);
        }
      }

      let builtPrompts:
        | Array<Record<string, unknown>>
        | undefined;
      if (prompts) {
        const { getRoles } = await import("../discord/guildData.js");
        const { resolveOne } = await import("../discord/resolve.js");
        const roles = await getRoles(rest, guildId);
        builtPrompts = [];
        for (const [promptIndex, prompt] of prompts.entries()) {
          const options: Array<Record<string, unknown>> = [];
          for (const [optionIndex, option] of prompt.options.entries()) {
            if (!option.channels?.length && !option.roles?.length) {
              return fail(
                `Option "${option.title}" grants nothing; every option ` +
                  "needs at least one channel or role."
              );
            }
            const channelIds: string[] = [];
            for (const entry of option.channels ?? []) {
              channelIds.push((await resolveChannel(rest, guildId, entry)).id);
            }
            const roleIds: string[] = [];
            for (const entry of option.roles ?? []) {
              const resolution = resolveOne(
                entry,
                roles.map((r) => ({ id: r.id, name: r.name, type: "role" }))
              );
              if (!("match" in resolution)) {
                return fail(`No single role matches "${entry}".`);
              }
              roleIds.push(resolution.match.id);
            }
            // New prompts and options still need id fields; Discord
            // replaces placeholder values with real snowflakes.
            options.push({
              id: String(optionIndex),
              title: option.title,
              ...(option.description ? { description: option.description } : {}),
              channel_ids: channelIds,
              role_ids: roleIds,
            });
          }
          builtPrompts.push({
            id: String(promptIndex),
            type: prompt.type === "dropdown" ? 1 : 0,
            title: prompt.title,
            options,
            single_select: prompt.single_select ?? false,
            required: prompt.required ?? false,
            in_onboarding: true,
          });
        }
      }

      const onboarding = (await rest.put(Routes.guildOnboarding(guildId), {
        body: {
          ...(builtPrompts !== undefined ? { prompts: builtPrompts } : {}),
          ...(defaultChannelIds !== undefined
            ? { default_channel_ids: defaultChannelIds }
            : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(mode !== undefined ? { mode: mode === "advanced" ? 1 : 0 } : {}),
        },
        reason: "Onboarding updated via Omnicord",
      })) as { enabled: boolean; prompts: Array<{ title: string }> };

      return ok(
        `Onboarding is now ${onboarding.enabled ? "enabled" : "disabled"} ` +
          `with ${onboarding.prompts.length} prompt(s).`,
        {
          enabled: onboarding.enabled,
          prompts: onboarding.prompts.map((p) => p.title),
        }
      );
    })
  );

  server.registerTool(
    "list_integrations",
    {
      title: "List integrations",
      description: "Installed integrations: bots, Twitch and YouTube links.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const integrations = (await rest.get(
        Routes.guildIntegrations(guildId)
      )) as APIGuildIntegration[];
      return ok(`${integrations.length} integration(s).`, {
        integrations: integrations.map((i) => ({
          id: i.id,
          name: i.name,
          type: i.type,
          enabled: i.enabled ?? null,
          application: i.application?.name ?? null,
        })),
      });
    })
  );

  server.registerTool(
    "delete_integration",
    {
      title: "Delete integration",
      description:
        "Remove an integration from the server. Safe to call directly: " +
        "the first call changes nothing and returns a preview plus a " +
        "confirm_token; repeating the call with the token removes it.",
      inputSchema: {
        integration_id: z.string().describe("Integration ID from list_integrations."),
        guild: guildParam,
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ integration_id, guild, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const integrations = (await rest.get(
        Routes.guildIntegrations(guildId)
      )) as APIGuildIntegration[];
      const target = integrations.find((i) => i.id === integration_id.trim());
      if (!target) {
        return fail(`No integration ${integration_id}. See list_integrations.`);
      }

      const gate = gateDestructive({
        tool: "delete_integration",
        args: { integration: target.id },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would remove the ${target.type} integration "${target.name}". ` +
          "Anything it powers stops working.",
        previewDetails: { id: target.id, name: target.name, type: target.type },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildIntegration(guildId, target.id), {
        reason: reason ?? "Removed via Omnicord",
      });
      return ok(`Removed the integration "${target.name}".`, {
        deleted: true,
        id: target.id,
      });
    })
  );

  server.registerTool(
    "list_server_templates",
    {
      title: "List server templates",
      description: "Discord templates created from this server.",
      inputSchema: { guild: guildParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const templates = (await rest.get(
        Routes.guildTemplates(guildId)
      )) as APITemplate[];
      return ok(`${templates.length} template(s).`, {
        templates: templates.map(templateDigest),
      });
    })
  );

  server.registerTool(
    "create_server_template",
    {
      title: "Create server template",
      description:
        "Snapshot this server's structure as a Discord template others " +
        "can create servers from. One template per server.",
      inputSchema: {
        guild: guildParam,
        name: z.string().min(1).max(100),
        description: z.string().max(120).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ guild, name, description }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const template = (await rest.post(Routes.guildTemplates(guildId), {
        body: { name, ...(description ? { description } : {}) },
      })) as APITemplate;
      return ok(
        `Template "${template.name}" created: ` +
          `https://discord.new/${template.code}`,
        templateDigest(template)
      );
    })
  );

  server.registerTool(
    "sync_server_template",
    {
      title: "Sync server template",
      description: "Update a template to match the server's current structure.",
      inputSchema: {
        code: z.string().describe("Template code from list_server_templates."),
        guild: guildParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ code, guild }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const template = (await rest.put(
        Routes.guildTemplate(guildId, code.trim())
      )) as APITemplate;
      return ok(`Template "${template.name}" synced to the current server state.`, templateDigest(template));
    })
  );

  server.registerTool(
    "delete_server_template",
    {
      title: "Delete server template",
      description:
        "Delete a server template; its share link stops working. Safe to " +
        "call directly: the first call changes nothing and returns a " +
        "preview plus a confirm_token; repeating the call with the token " +
        "deletes it.",
      inputSchema: {
        code: z.string().describe("Template code."),
        guild: guildParam,
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ code, guild, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(perms, [[P.ManageGuild, "Manage Server"]], "in this server");

      const gate = gateDestructive({
        tool: "delete_server_template",
        args: { code: code.trim() },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would delete the template ${code.trim()}; anyone holding its ` +
          "discord.new link can no longer use it.",
        previewDetails: { code: code.trim() },
      });
      if (gate) return gate;

      await rest.delete(Routes.guildTemplate(guildId, code.trim()));
      return ok(`Deleted the template ${code.trim()}.`, {
        deleted: true,
        code: code.trim(),
      });
    })
  );

  server.registerTool(
    "prune_members",
    {
      title: "Prune members",
      description:
        "Remove members inactive for a number of days who hold no roles. " +
        "Safe to call directly: the first call counts who would go using " +
        "Discord's own preview and returns a confirm_token; repeating the " +
        "call with the token prunes for real.",
      inputSchema: {
        guild: guildParam,
        days: z.number().int().min(1).max(30)
          .describe("Inactivity threshold in days."),
        reason: z.string().max(400).optional(),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ guild, days, reason, dry_run, confirm_token }) => {
      const { rest, guildId } = await enter(config, guild);
      const perms = await botPermissions(rest, guildId);
      requirePermissions(
        perms,
        [
          [P.KickMembers, "Kick Members"],
          [P.ManageGuild, "Manage Server"],
        ],
        "in this server"
      );

      // Discord's native prune-count endpoint makes the preview exact.
      const count = (await rest.get(Routes.guildPrune(guildId), {
        query: new URLSearchParams({ days: String(days) }),
      })) as { pruned: number };

      const gate = gateDestructive({
        tool: "prune_members",
        args: { guild: guildId, days },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would prune exactly ${count.pruned} member(s) inactive for ` +
          `${days}+ day(s) holding no roles. They can rejoin with invites.`,
        previewDetails: { would_prune: count.pruned, days },
      });
      if (gate) return gate;

      // Discord allows only a few prune executions per guild in a several
      // minute window (error 30040), and the rate limiter would otherwise
      // quietly queue the request for that entire window. A short abort
      // turns the wait into an answer.
      try {
        const result = (await rest.post(Routes.guildPrune(guildId), {
          body: { days, compute_prune_count: true },
          reason: reason ?? "Pruned via Omnicord",
          signal: AbortSignal.timeout(15_000),
        })) as { pruned: number | null };
        return ok(`Pruned ${result.pruned ?? "an unknown number of"} member(s).`, {
          pruned: result.pruned,
          days,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return fail(
            "Discord limits prune executions to a few per guild every " +
              "several minutes, and that allowance is used up. The preview " +
              "count is not limited; try the execution again in about five " +
              "minutes."
          );
        }
        throw err;
      }
    })
  );

  server.registerTool(
    "set_bot_presence",
    {
      title: "Set bot presence",
      description:
        "Change the bot's status dot and custom status text. Needs the " +
        "gateway connection that Omnicord keeps by default.",
      inputSchema: {
        status: z.enum(["online", "idle", "dnd", "invisible"]),
        activity_text: z.string().max(128).optional()
          .describe("Custom status text shown under the bot's name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ status, activity_text }) => {
      const problem = await setPresence({ status, activityText: activity_text });
      if (problem) return fail(problem);
      return ok(
        `Presence set to ${status}` +
          (activity_text ? ` with status "${activity_text}"` : "") +
          ".",
        { status, activity_text: activity_text ?? null }
      );
    })
  );
}
