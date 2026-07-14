import { DiscordAPIError, type REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type {
  RESTGetAPICurrentUserGuildsResult,
  RESTGetAPIUserResult,
  RESTGetCurrentApplicationResult,
} from "discord-api-types/v10";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BotConfig, OmnicordConfig } from "../config.js";
import { VERSION } from "../config.js";
import { ok, fail } from "../envelope.js";
import { enterBot, botParam, ToolProblem } from "./common.js";

import { readIntents } from "../discord/intents.js";
import { getGatewayState } from "../discord/gateway.js";
import { rateLimitStats } from "../discord/rateLimit.js";

interface SetupCheck {
  check: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

const PORTAL_BOT_PAGE =
  "https://discord.com/developers/applications, select your app, Bot page";

export function registerDiagnostics(
  server: McpServer,
  config: OmnicordConfig
): void {
  server.registerTool(
    "get_rate_limit_status",
    {
      title: "Get rate limit status",
      description:
        "How rate limiting has been going: how many times Discord asked " +
        "Omnicord to slow down (the request layer waits automatically), " +
        "and the invalid-request counter that matters because Discord " +
        "temporarily bans an IP after 10,000 invalid responses in ten " +
        "minutes. Useful when calls feel slow.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const stats = rateLimitStats();
      return ok(
        `${stats.rate_limit_hits} rate-limit wait(s) so far` +
          (stats.invalid_request_warnings > 0
            ? `, ${stats.invalid_request_count} invalid request(s) tracked`
            : "") +
          ".",
        stats
      );
    }
  );

  server.registerTool(
    "get_bot_info",
    {
      title: "Get bot info",
      description:
        "Identity and status of a connected Discord bot: bot user, " +
        "application, guild count, enabled gateway intents, and the " +
        "Omnicord version. With more than one bot configured, pass bot to " +
        "pick which (list_servers shows the configured bots). Use " +
        "run_setup_check for a full health check with fix instructions.",
      inputSchema: { bot: botParam },
      annotations: { readOnlyHint: true },
    },
    async ({ bot: botArg }) => {
      let entered: { rest: REST; bot: BotConfig };
      try {
        entered = enterBot(config, botArg);
      } catch (err) {
        if (err instanceof ToolProblem) return err.result;
        throw err;
      }
      const { rest, bot: selectedBot } = entered;

      try {
        const [user, app, guilds] = await Promise.all([
          rest.get(Routes.user("@me")) as Promise<RESTGetAPIUserResult>,
          rest.get(
            Routes.currentApplication()
          ) as Promise<RESTGetCurrentApplicationResult>,
          rest.get(
            Routes.userGuilds()
          ) as Promise<RESTGetAPICurrentUserGuildsResult>,
        ]);

        const intents = readIntents(app.flags ?? 0);
        // The guild list endpoint returns at most 200 entries per page.
        // Pagination is not worth wiring up until a bot of ours can
        // realistically exceed that.
        const guildCount = guilds.length;
        const guildCountDisplay =
          guildCount >= 200 ? "200 or more" : String(guildCount);

        const intentSummary = [
          intents.members ? "members on" : "members OFF",
          intents.messageContent ? "message content on" : "message content OFF",
          intents.presence ? "presence on" : "presence off",
        ].join(", ");

        return ok(
          `Logged in as ${user.username} (app: ${app.name}). ` +
            `In ${guildCountDisplay} servers. Intents: ${intentSummary}. ` +
            `Omnicord v${VERSION}.`,
          {
            bot: {
              id: user.id,
              username: user.username,
              name: selectedBot.name,
            },
            application: { id: app.id, name: app.name },
            guilds: {
              count: guildCount,
              capped: guildCount >= 200,
              // First few guilds by id and name. Enough for a human or a
              // model to grab the right id for OMNICORD_GUILD without a
              // separate lookup.
              list: guilds
                .slice(0, 10)
                .map((g) => ({ id: g.id, name: g.name })),
            },
            gateway: getGatewayState(),
            intents,
            omnicord: { version: VERSION },
          }
        );
      } catch (err) {
        return describeRestError(err);
      }
    }
  );

  server.registerTool(
    "run_setup_check",
    {
      title: "Run setup check",
      description:
        "End-to-end health check of the Omnicord setup: token presence and " +
        "validity, privileged gateway intent toggles, guild count against " +
        "Discord's verification thresholds, and default guild membership. " +
        "Every failed check comes with instructions for fixing it. With more " +
        "than one bot configured, pass bot to check a specific one. Run this " +
        "first when anything misbehaves.",
      inputSchema: { bot: botParam },
      annotations: { readOnlyHint: true },
    },
    async ({ bot: botArg }) => {
      const checks: SetupCheck[] = [];

      // Check 1: a bot is configured.
      if (config.bots.length === 0) {
        checks.push({
          check: "token_present",
          status: "fail",
          detail: "No DISCORD_TOKEN is set.",
          fix:
            "Set DISCORD_TOKEN in the MCP server config (env section) or in " +
            "a .env file. Get the token from " +
            PORTAL_BOT_PAGE +
            ", Reset Token.",
        });
        return finishChecks(checks);
      }
      let entered: { rest: REST; bot: BotConfig };
      try {
        entered = enterBot(config, botArg);
      } catch (err) {
        if (err instanceof ToolProblem) return err.result;
        throw err;
      }
      const { rest, bot } = entered;
      checks.push({
        check: "token_present",
        status: "pass",
        detail:
          config.bots.length > 1
            ? `Checking bot "${bot.name}" of ${config.bots.length} configured.`
            : "DISCORD_TOKEN is set.",
      });

      // Check 2: token valid. A 401 from /users/@me means Discord rejected
      // the token itself.
      let app: RESTGetCurrentApplicationResult;
      let guilds: RESTGetAPICurrentUserGuildsResult;
      try {
        await rest.get(Routes.user("@me"));
        checks.push({
          check: "token_valid",
          status: "pass",
          detail: "Discord accepted the token.",
        });
        [app, guilds] = await Promise.all([
          rest.get(
            Routes.currentApplication()
          ) as Promise<RESTGetCurrentApplicationResult>,
          rest.get(
            Routes.userGuilds()
          ) as Promise<RESTGetAPICurrentUserGuildsResult>,
        ]);
      } catch (err) {
        if (err instanceof DiscordAPIError && err.status === 401) {
          checks.push({
            check: "token_valid",
            status: "fail",
            detail: "Discord rejected the token (401 Unauthorized).",
            fix:
              "The token is wrong, expired, or was reset. Generate a fresh " +
              "one at " +
              PORTAL_BOT_PAGE +
              ", Reset Token, and update DISCORD_TOKEN.",
          });
          return finishChecks(checks);
        }
        throw err;
      }

      // Check 3: privileged intents. Members and Message Content gate core
      // functionality (member search, reading messages). Presence is only
      // needed for presence-based features and stays optional.
      const intents = readIntents(app.flags ?? 0);
      const intentFix =
        "Open " +
        PORTAL_BOT_PAGE +
        ", scroll to Privileged Gateway Intents, and turn the toggle on. " +
        "Under 100 servers this needs no review.";
      checks.push({
        check: "intent_members",
        status: intents.members ? "pass" : "fail",
        detail: intents.members
          ? "Server Members intent is enabled."
          : "Server Members intent is disabled. Member listing and search will not work.",
        ...(intents.members ? {} : { fix: intentFix }),
      });
      checks.push({
        check: "intent_message_content",
        status: intents.messageContent ? "pass" : "fail",
        detail: intents.messageContent
          ? "Message Content intent is enabled."
          : "Message Content intent is disabled. Reading and searching messages will not work.",
        ...(intents.messageContent ? {} : { fix: intentFix }),
      });
      checks.push({
        check: "intent_presence",
        status: intents.presence ? "pass" : "warn",
        detail: intents.presence
          ? "Presence intent is enabled."
          : "Presence intent is disabled. Fine unless presence features are needed.",
      });

      // Check 4: guild count against Discord's verification thresholds.
      // Verification applications open at 75 servers and become mandatory
      // at 100, where unverified bots stop being able to join guilds and
      // privileged intents require approval.
      const count = guilds.length;
      if (count >= 100) {
        checks.push({
          check: "guild_count",
          status: "warn",
          detail: `Bot is in ${count} servers, at or past the verification gate.`,
          fix: "Verification and intent approval are required at this size.",
        });
      } else if (count >= 75) {
        checks.push({
          check: "guild_count",
          status: "warn",
          detail: `Bot is in ${count} servers. Verification applications open at 75; the hard gate is 100.`,
        });
      } else {
        checks.push({
          check: "guild_count",
          status: "pass",
          detail: `Bot is in ${count} servers, comfortably under the 100-server verification gate.`,
        });
      }

      // Check 5: the gateway connection, which powers presence and event
      // subscriptions. Not fatal: every REST tool works without it.
      const gateway = getGatewayState();
      if (gateway.status === "connected") {
        checks.push({
          check: "gateway",
          status: "pass",
          detail: `Gateway connected since ${gateway.since}; the bot shows as online.`,
        });
      } else if (gateway.status === "connecting") {
        checks.push({
          check: "gateway",
          status: "warn",
          detail: "Gateway is still connecting; presence and events start shortly.",
        });
      } else if (gateway.status === "off") {
        checks.push({
          check: "gateway",
          status: "warn",
          detail: `Gateway is off (${gateway.reason}); the bot shows offline and event subscriptions are unavailable. REST tools are unaffected.`,
        });
      } else {
        checks.push({
          check: "gateway",
          status: "warn",
          detail: `Gateway error: ${gateway.message}. REST tools are unaffected.`,
          fix: "Restart Omnicord; if it persists, check the token and network.",
        });
      }

      // Check 6: default guild membership, only when one is configured.
      if (config.defaultGuild) {
        const present = guilds.some((g) => g.id === config.defaultGuild);
        checks.push({
          check: "default_guild",
          status: present ? "pass" : "fail",
          detail: present
            ? `Bot is a member of the default guild (${config.defaultGuild}).`
            : `Bot is not in the configured default guild (${config.defaultGuild}).`,
          ...(present
            ? {}
            : {
                fix:
                  "Invite the bot to that server, or fix OMNICORD_GUILD. " +
                  "Build the invite URL in the Developer Portal under " +
                  "OAuth2, URL Generator, with the bot scope.",
              }),
        });
      }

      return finishChecks(checks);
    }
  );
}

function finishChecks(checks: SetupCheck[]) {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  const passes = checks.length - fails.length - warns.length;

  let summary = `Setup check: ${passes}/${checks.length} passed`;
  if (warns.length > 0) summary += `, ${warns.length} warning(s)`;
  if (fails.length > 0) {
    summary += `, ${fails.length} FAILED. First failure: ${fails[0].detail}`;
  } else {
    summary += ".";
  }

  const warnings = warns.map((w) => w.detail);
  return fails.length > 0
    ? fail(summary, { checks })
    : ok(summary, { checks }, warnings);
}

// Translates Discord REST errors into something actionable instead of a
// bare status code.
function describeRestError(err: unknown) {
  if (err instanceof DiscordAPIError) {
    if (err.status === 401) {
      return fail(
        "Discord rejected the bot token (401). Reset it in the Developer " +
          "Portal and update DISCORD_TOKEN.",
        { discord_error: { code: err.code, status: err.status } }
      );
    }
    return fail(`Discord API error ${err.status}: ${err.message}`, {
      discord_error: { code: err.code, status: err.status },
    });
  }
  throw err;
}
