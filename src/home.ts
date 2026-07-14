import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createRequire } from "node:module";

// Where Omnicord keeps user data: the .env the wizard writes, saved
// blueprints, and scheduled messages.
//
// A source checkout keeps everything next to package.json, which is what
// development and the test suites expect. An installed copy is different:
// the npx cache, a global install, and a node_modules dependency all live
// in directories that package managers delete and replace (npm cache
// clean, version upgrades), so user data there would not survive. For
// installed copies everything moves to a stable folder in the user
// profile, ~/.omnicord, which outlives any reinstall.

export const PACKAGE_ROOT = dirname(
  createRequire(import.meta.url).resolve("../package.json")
);

// Inside any node_modules means installed by a package manager rather
// than checked out from source.
export const IS_INSTALLED = PACKAGE_ROOT.split(sep).includes("node_modules");

// The directory that holds the .env and bots.json the wizard writes and the
// server reads. OMNICORD_HOME overrides it, for a custom location, a container,
// or an isolated test run; otherwise a source checkout keeps config at the
// package root and an installed copy uses ~/.omnicord. config.ts reads the same
// override, so the wizard and the server always agree on where config lives.
export function configDir(): string {
  const override = process.env.OMNICORD_HOME?.trim();
  if (override) return override;
  return IS_INSTALLED ? join(homedir(), ".omnicord") : PACKAGE_ROOT;
}

export function dataDir(): string {
  const override = process.env.OMNICORD_DATA_DIR?.trim();
  if (override) return override;
  const home = process.env.OMNICORD_HOME?.trim();
  if (home) return join(home, ".omnicord");
  return IS_INSTALLED
    ? join(homedir(), ".omnicord")
    : join(PACKAGE_ROOT, ".omnicord");
}

// Where the wizard writes DISCORD_TOKEN and OMNICORD_GUILD (single-bot) and
// the bots.json (multi-bot). The server loads both from the same directory
// (see config.ts), so the wizard and the server always agree.
export function envFilePath(): string {
  return join(configDir(), ".env");
}

export function botsFilePath(): string {
  return join(configDir(), "bots.json");
}
