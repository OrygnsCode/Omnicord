import { REST } from "@discordjs/rest";
import type { OmnicordConfig } from "../config.js";
import { attachRateLimitObserver } from "./rateLimit.js";

// Thin wrapper around the Discord REST client. @discordjs/rest already
// queues requests per route bucket and honors the rate limit headers, so
// for now we lean on that. The catalog's circuit breaker for invalid
// requests gets layered on top in a later phase.

let rest: REST | undefined;

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

export function getRest(config: OmnicordConfig): REST {
  if (!config.token) {
    throw new NoTokenError();
  }
  if (!rest) {
    rest = new REST({ version: "10" }).setToken(config.token);
    attachRateLimitObserver(rest);
  }
  return rest;
}
