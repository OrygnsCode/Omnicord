import { config as loadDotenv } from "dotenv";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Load .env from the working directory when present, then the package
// root, then ~/.omnicord. The package-root fallback matters because MCP
// clients spawn this server from whatever directory they please, and a
// developer's .env lives next to package.json. The home fallback is where
// the wizard saves the token for installed copies (npx, global installs),
// since package-manager directories get deleted and replaced. dotenv never
// overrides variables that are already set, so real environment variables
// always win over every file.
// quiet:true matters too: dotenv v17 prints a banner to stdout by default,
// and anything on stdout that is not a JSON-RPC message breaks the stdio
// transport.
const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("../package.json");

loadDotenv({ quiet: true });
loadDotenv({ path: join(dirname(packageJsonPath), ".env"), quiet: true });
loadDotenv({ path: join(homedir(), ".omnicord", ".env"), quiet: true });

const pkg = require(packageJsonPath) as {
  version: string;
};

export const VERSION: string = pkg.version;

export interface OmnicordConfig {
  // Bot token, possibly absent. The server boots without one so that
  // diagnostics can tell the user what to fix instead of crashing.
  token: string | undefined;
  // Optional default guild ID. Tools accept an explicit guild and fall
  // back to this.
  defaultGuild: string | undefined;
}

export function loadConfig(): OmnicordConfig {
  const token = process.env.DISCORD_TOKEN?.trim() || undefined;
  const defaultGuild = process.env.OMNICORD_GUILD?.trim() || undefined;
  return { token, defaultGuild };
}
