import { REST } from "@discordjs/rest";
import type { OmnicordConfig } from "../config.js";
import { attachRateLimitObserver } from "./rateLimit.js";

// Thin wrapper around the Discord REST client. @discordjs/rest already
// queues requests per route bucket and honors the rate limit headers, so
// for now we lean on that. The catalog's circuit breaker for invalid
// requests gets layered on top in a later phase.
//
// One REST client is built per bot token and reused. @discordjs/rest keeps
// its rate-limit buckets inside each instance, so a separate client per
// token means bots never share a rate-limit lane or step on each other.

const restByToken = new Map<string, REST>();

export class NoTokenError extends Error {
  constructor() {
    super(
      "No Discord bot token configured. Set DISCORD_TOKEN in the MCP server " +
        "config or in a .env file next to the server. Tokens come from " +
        "https://discord.com/developers/applications under your app's Bot page."
    );
    this.name = "NoTokenError";
  }
}

// The REST client for a specific bot token, built lazily and cached.
export function getRestForToken(token: string): REST {
  let rest = restByToken.get(token);
  if (!rest) {
    rest = new REST({ version: "10" }).setToken(token);
    attachRateLimitObserver(rest);
    restByToken.set(token, rest);
  }
  return rest;
}

// The REST client for the default bot. Single-bot call sites use this and
// are unaffected by multi-bot configuration.
export function getRest(config: OmnicordConfig): REST {
  if (!config.token) {
    throw new NoTokenError();
  }
  return getRestForToken(config.token);
}
