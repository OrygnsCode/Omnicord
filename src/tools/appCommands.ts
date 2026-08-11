import { z } from "zod";
import { Routes, ApplicationCommandOptionType } from "discord-api-types/v10";
import type {
  APIApplicationCommand,
  APIApplicationCommandOption,
  RESTGetCurrentApplicationResult,
} from "discord-api-types/v10";
import type { REST } from "@discordjs/rest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnicordConfig } from "../config.js";
import { gateDestructive } from "../safety.js";
import { ok, fail } from "../envelope.js";
import { enter, enterBot, guarded, guildParam, botParam, ToolProblem } from "./common.js";

// Slash commands belong to the Discord application, not to a server, so these
// tools authorise on owning the application rather than on a guild permission.
// A command registered without a guild is global: it appears everywhere the
// app is installed but can take up to an hour to propagate, and global
// registrations are rate limited per day. A command registered to a guild
// appears there immediately, which is what you want while iterating.
//
// Subcommands and subcommand groups are out of scope here. They need a nested
// option tree that is awkward to express as a flat tool argument, and a server
// builder rarely needs them. Everything else Discord supports is covered.

const OPTION_TYPES = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
  mentionable: ApplicationCommandOptionType.Mentionable,
  attachment: ApplicationCommandOptionType.Attachment,
} as const;

const TYPE_LABELS: Record<number, string> = Object.fromEntries(
  Object.entries(OPTION_TYPES).map(([label, value]) => [value, label])
);

const optionSchema = z.object({
  name: z.string().describe("Option name, lowercase, no spaces."),
  description: z.string().describe("What the option is for."),
  type: z
    .enum(Object.keys(OPTION_TYPES) as [string, ...string[]])
    .default("string")
    .describe("Value type. Defaults to string."),
  required: z.boolean().optional().describe("Whether the user must supply it."),
  choices: z
    .array(z.object({ name: z.string(), value: z.union([z.string(), z.number()]) }))
    .optional()
    .describe("Fixed set of allowed values, for string, integer, and number options."),
});

function toApiOptions(
  options: z.infer<typeof optionSchema>[] | undefined
): APIApplicationCommandOption[] | undefined {
  if (!options?.length) return undefined;
  // Discord requires every required option to come before the optional ones.
  const ordered = [...options].sort(
    (a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required))
  );
  return ordered.map((o) => ({
    name: o.name,
    description: o.description,
    type: OPTION_TYPES[o.type as keyof typeof OPTION_TYPES],
    required: o.required ?? false,
    ...(o.choices?.length ? { choices: o.choices } : {}),
  })) as APIApplicationCommandOption[];
}

function digest(cmd: APIApplicationCommand) {
  return {
    id: cmd.id,
    name: cmd.name,
    description: cmd.description,
    scope: cmd.guild_id ? "guild" : "global",
    guild_id: cmd.guild_id,
    options: (cmd.options ?? []).map((o) => ({
      name: o.name,
      type: TYPE_LABELS[o.type] ?? String(o.type),
      required: Boolean((o as { required?: boolean }).required),
    })),
  };
}

async function applicationId(rest: REST): Promise<string> {
  const app = (await rest.get(
    Routes.currentApplication()
  )) as RESTGetCurrentApplicationResult;
  return app.id;
}

// Where a command lives. Passing a guild routes through the normal guild
// resolution, so the bot that is actually in that server does the work.
async function scope(
  config: OmnicordConfig,
  guild: string | undefined,
  bot: string | undefined
): Promise<{ rest: REST; guildId?: string; where: string }> {
  if (guild) {
    const entered = await enter(config, guild, bot);
    return { rest: entered.rest, guildId: entered.guildId, where: entered.guildName };
  }
  const { rest } = enterBot(config, bot);
  return { rest, where: "globally" };
}

function commandsRoute(appId: string, guildId?: string) {
  return guildId
    ? Routes.applicationGuildCommands(appId, guildId)
    : Routes.applicationCommands(appId);
}

function commandRoute(appId: string, commandId: string, guildId?: string) {
  return guildId
    ? Routes.applicationGuildCommand(appId, guildId, commandId)
    : Routes.applicationCommand(appId, commandId);
}

async function resolveCommand(
  rest: REST,
  appId: string,
  guildId: string | undefined,
  wanted: string
): Promise<APIApplicationCommand> {
  const all = (await rest.get(commandsRoute(appId, guildId))) as APIApplicationCommand[];
  const needle = wanted.trim().toLowerCase().replace(/^\//, "");
  const found =
    all.find((c) => c.id === wanted) ??
    all.find((c) => c.name.toLowerCase() === needle);
  if (!found) {
    const names = all.map((c) => `/${c.name}`).join(", ") || "none";
    throw new ToolProblem(
      fail(
        `No ${guildId ? "guild" : "global"} command matches "${wanted}". ` +
          `Registered: ${names}.`
      )
    );
  }
  return found;
}

export function registerAppCommandTools(server: McpServer, config: OmnicordConfig) {
  server.registerTool(
    "list_app_commands",
    {
      title: "List app commands",
      description:
        "The slash commands this bot's application has registered. Omit " +
        "guild for the global set, or pass a guild for that server's set. " +
        "Guild commands and global commands are separate lists; a name can " +
        "exist in both.",
      inputSchema: { guild: guildParam, bot: botParam },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ guild, bot }) => {
      const { rest, guildId, where } = await scope(config, guild, bot);
      const appId = await applicationId(rest);
      const all = (await rest.get(
        commandsRoute(appId, guildId)
      )) as APIApplicationCommand[];
      return ok(
        all.length
          ? `${all.length} command${all.length === 1 ? "" : "s"} registered ` +
              `${guildId ? `in ${where}` : "globally"}.`
          : `No commands registered ${guildId ? `in ${where}` : "globally"}.`,
        { scope: guildId ? "guild" : "global", commands: all.map(digest) }
      );
    })
  );

  server.registerTool(
    "register_app_command",
    {
      title: "Register app command",
      description:
        "Register a slash command, or update it in place if the name is " +
        "already taken. Pass a guild while iterating: guild commands appear " +
        "immediately, while global commands can take up to an hour to show " +
        "up everywhere and are rate limited per day. Subcommands and " +
        "subcommand groups are not supported here.",
      inputSchema: {
        name: z
          .string()
          .describe("Command name without the slash, lowercase, no spaces."),
        description: z.string().describe("Shown to users in the command picker."),
        options: z.array(optionSchema).optional().describe("Arguments the command takes."),
        guild: guildParam,
        bot: botParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ name, description, options, guild, bot }) => {
      const { rest, guildId, where } = await scope(config, guild, bot);
      const appId = await applicationId(rest);
      const clean = name.trim().replace(/^\//, "").toLowerCase();
      const created = (await rest.post(commandsRoute(appId, guildId), {
        body: { name: clean, description, options: toApiOptions(options) },
      })) as APIApplicationCommand;
      return ok(
        `/${created.name} is registered ${guildId ? `in ${where}` : "globally"}.`,
        digest(created),
        guildId
          ? undefined
          : ["Global commands can take up to an hour to appear in every server."]
      );
    })
  );

  server.registerTool(
    "update_app_command",
    {
      title: "Update app command",
      description:
        "Change a registered command's description or options. Anything not " +
        "passed is left as it is. Replacing options replaces the whole list, " +
        "so send every option you want to keep.",
      inputSchema: {
        command: z.string().describe("Command name or ID."),
        description: z.string().optional().describe("New description."),
        options: z
          .array(optionSchema)
          .optional()
          .describe("Replacement option list, replacing the existing one entirely."),
        guild: guildParam,
        bot: botParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guarded(async ({ command, description, options, guild, bot }) => {
      const { rest, guildId, where } = await scope(config, guild, bot);
      const appId = await applicationId(rest);
      const found = await resolveCommand(rest, appId, guildId, command);

      const body: Record<string, unknown> = {};
      if (description !== undefined) body.description = description;
      if (options !== undefined) body.options = toApiOptions(options) ?? [];
      if (Object.keys(body).length === 0) {
        return fail(
          "Nothing to change. Pass description, options, or both."
        );
      }

      const updated = (await rest.patch(commandRoute(appId, found.id, guildId), {
        body,
      })) as APIApplicationCommand;
      return ok(
        `/${updated.name} updated ${guildId ? `in ${where}` : "globally"}.`,
        digest(updated)
      );
    })
  );

  server.registerTool(
    "delete_app_command",
    {
      title: "Delete app command",
      description:
        "Unregister a slash command so it no longer appears for users. Safe " +
        "to call directly: the first call changes nothing and returns a " +
        "preview plus a confirm_token; repeating the call with the token " +
        "removes it.",
      inputSchema: {
        command: z.string().describe("Command name or ID."),
        guild: guildParam,
        bot: botParam,
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async ({ command, guild, bot, dry_run, confirm_token }) => {
      const { rest, guildId, where } = await scope(config, guild, bot);
      const appId = await applicationId(rest);
      const found = await resolveCommand(rest, appId, guildId, command);

      const gate = gateDestructive({
        tool: "delete_app_command",
        args: { command: found.id, guild: guildId ?? "global" },
        dryRun: dry_run,
        confirmToken: confirm_token,
        previewSummary:
          `Would unregister /${found.name} ` +
          `${guildId ? `in ${where}` : "globally"}; it stops appearing for ` +
          "users. Registering it again restores it.",
        previewDetails: digest(found),
      });
      if (gate) return gate;

      await rest.delete(commandRoute(appId, found.id, guildId));
      return ok(
        `/${found.name} is unregistered ${guildId ? `in ${where}` : "globally"}.`,
        digest(found)
      );
    })
  );
}
