# Contributing

Thanks for your interest in Omnicord. This document covers how the project is
laid out, the workflow we expect for changes, and the conventions that keep the
codebase consistent.

If you only want to report a bug or request a feature, the
[issue templates](https://github.com/OrygnsCode/Omnicord/issues/new/choose) are
the fastest path. For security problems, follow [SECURITY.md](./SECURITY.md)
instead of opening a public issue.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Licensing and sign-off

Omnicord is source available under the [Elastic License 2.0](./LICENSE), which
is not an OSI-approved open source license. Read it before you contribute. In
plain terms: anyone may use, modify, and self-host the code, including inside a
business. The one thing the license forbids is offering Omnicord to third
parties as a hosted or managed service.

Contributions are accepted under that same license. Instead of a CLA we use the
[Developer Certificate of Origin](https://developercertificate.org/). Sign off
every commit:

```bash
git commit -s
```

That appends a `Signed-off-by:` trailer certifying you wrote the patch, or
otherwise have the right to submit it under the Elastic License 2.0. Pull
requests with unsigned commits will be asked to sign off before merge.

## Prerequisites

- Node.js **20** or later. CI runs Node 20, 22, and 24 on Ubuntu, plus Node 24
  on macOS and Windows.
- A recent `npm` (ships with Node 20+).
- For the live acceptance suite only: a Discord bot token and a **disposable**
  test server. Read the warning in [Testing](#testing) first.

## Getting started

```bash
git clone https://github.com/OrygnsCode/Omnicord.git
cd Omnicord
npm install
npm run build
```

To iterate locally:

```bash
npm run dev
```

`tsx` runs the server straight from source. Omnicord speaks MCP over stdio, so
the easiest way to drive it during development is to point a real client at the
build. See [docs/clients.md](./docs/clients.md) for per-client configuration.

## Repository layout

```
src/
  index.ts            # Entry point: stdio, --http, and the init wizard
  server.ts           # Builds the McpServer and registers every tool group
  config.ts           # Environment, .env, and bots.json loading; VERSION
  home.ts             # Config and data locations (OMNICORD_HOME)
  safety.ts           # The confirmation gate (gateDestructive)
  envelope.ts         # The ok() / fail() output envelope
  http.ts             # Streamable HTTP transport and its security gates
  scheduler.ts        # Omnicord-side scheduled messages
  wizard.ts           # The interactive setup wizard
  wizardLib.ts        # Pure wizard logic (client detection, config merge)
  discord/
    preflight.ts      # Permission computation, presets, canModerate
    resolve.ts        # The name-to-entity resolver
    botRouting.ts     # Multi-bot: which bot acts for a given server
    actingContext.ts  # Per-call acting bot, read by the safety gate
    guildData.ts      # Cached guild reads
    gateway.ts        # Gateway connection and live events
    rateLimit.ts      # Rate limit accounting
    intents.ts        # Privileged intent negotiation
  builder/
    planner.ts        # Blueprint to ordered build plan
    executor.ts       # Plan to live server (additive only)
    diff.ts           # Blueprint drift detection
    overwrites.ts     # private_to / read_only compiled to permission overwrites
  tools/
    common.ts         # Shared helpers: enter, guarded, resolvers, permissions
    read.ts           # One file per tool group; see docs/tool-catalog.md
    write.ts moderation.ts manage.ts ...
scripts/
  unit.mjs            # Pure logic. No network, no token.
  smoke.mjs           # Full stdio protocol session. No token needed.
  smoke-http.mjs      # HTTP transport, sessions, auth, security gates.
  acceptance.mjs      # Live end-to-end against a real Discord server.
  smoke-docker.mjs    # Builds and verifies the container image.
docs/                 # Getting started, clients, self-hosting, security, tools
```

## Testing

The same checks CI runs:

```bash
npm test        # build + unit + smoke + smoke-http
```

Individually:

```bash
node scripts/unit.mjs        # resolver, permissions, planner, the gate
node scripts/smoke.mjs       # stdio protocol session, no token needed
node scripts/smoke-http.mjs  # HTTP transport, auth, security gates
```

The unit and smoke suites need no Discord token, so anyone can run them. They
are also the fastest way to see the confirmation gate work: the unit suite
asserts every property of it, and the smoke suite drives a destructive tool
through the full protocol and watches it get blocked, then succeed only after
confirmation.

### The acceptance suite

```bash
node scripts/acceptance.mjs
```

**This talks to a real Discord server and creates, modifies, and deletes real
things.** It cleans up after itself, but it must only ever be pointed at a
**disposable test server you own**. Never run it against a live community.

It reads `DISCORD_TOKEN` and `OMNICORD_GUILD` from `.env`. Create a throwaway
Discord application and an empty server for it, and double check
`get_bot_info` reports the bot and guild you expect before you run it.

`scripts/smoke-docker.mjs` builds and verifies the container image and needs a
running Docker daemon.

## The safety gate

This is the architectural invariant of the project. Read it before touching any
tool that changes state.

Destructive operations never execute on the first call. They return a
human-readable preview plus a single-use `confirm_token` bound to that exact
action, and only a second call carrying that token executes. The gate lives in
[`src/safety.ts`](./src/safety.ts) and is enforced by the server, not by the
model's judgment.

Every destructive tool wires it the same way, **before** any Discord call:

```ts
const gate = gateDestructive({
  tool: "delete_channel",
  args: { channel: target.id },
  dryRun: dry_run,
  confirmToken: confirm_token,
  previewSummary: `Would delete the text ${target.name}. Every message in it is lost forever.`,
  previewDetails: { id: target.id, name: target.name },
});
if (gate) return gate;

// Only reachable with a valid token, or with safe mode off.
await rest.delete(Routes.channel(target.id), { reason: "Deleted via Omnicord" });
```

If you add a tool that deletes content, removes access, punishes a member, or
fans a change out across many entities, it **must** go through the gate, and it
must carry `annotations: { destructiveHint: true }`. A pull request that adds a
destructive path without the gate will not be merged.

Moderation tools additionally preflight Discord's rules before the gate, so the
failure mode is an explanation rather than a bare 403: bot permission, self
protection, owner protection, and strict role hierarchy. See `canModerate` in
[`src/discord/preflight.ts`](./src/discord/preflight.ts).

## Adding a new tool

1. Pick the right file in `src/tools/`. Group by domain, not by verb.
2. Name it `verb_object` in snake_case (`create_channel`, `ban_member`). No
   `discord_` prefix; the server is the namespace.
3. Define the input schema with `zod`. Entity parameters accept a name or an ID
   and go through the resolver, so a caller never has to hunt for a snowflake.
4. Preflight the bot's permissions with `requirePermissions` before calling
   Discord, so a missing permission is explained rather than thrown.
5. If it is destructive, wire the confirmation gate (see above).
6. Return `ok(summary, data, warnings)` or `fail(message)` from
   [`src/envelope.ts`](./src/envelope.ts). Never throw across the MCP boundary.
7. Write the tool description for the model that has to choose it. Lead with
   what it does, and disambiguate against similar tools by name.
8. Add coverage: unit tests for any pure logic, a registration assertion in
   `scripts/smoke.mjs`, and a live check in `scripts/acceptance.mjs` that cleans
   up whatever it creates.
9. Update [docs/tool-catalog.md](./docs/tool-catalog.md). The catalog is the
   contract, not an afterthought. Update the tool count there, in the smoke
   test, in the README, and in `mcpb/manifest.json`.

## Conventions

- **Never write to stdout.** The MCP stdio transport owns that channel. Anything
  else on it corrupts the JSON-RPC stream and breaks the client connection.
  `stderr` is acceptable for genuinely fatal startup failures.
- **Never log the bot token**, and never put it in a client config. It is read
  from the environment or a gitignored `.env` and stays there.
- Input fields are `snake_case`. Type names and exported symbols follow standard
  TypeScript conventions.
- Prose in the repository, including the README, docs, and tool descriptions, is
  plain and concrete. No emoji, no em dashes, and no marketing language.

## Commit messages

We do not enforce conventional commits, but we do prefer:

- A short, imperative subject line, 72 characters or fewer.
- A blank line.
- A body that explains why the change is needed, not what the diff already
  shows.

Reference issues with `Fixes #123` or `Refs #123`. Remember `git commit -s`.

## Pull requests

- Keep pull requests focused. One logical change per pull request.
- Fill in the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md)
  honestly.
- If a change is user-visible, update the README, the tool catalog, and
  `CHANGELOG.md`.
- All checks must pass before review.

## Releases

Maintainers cut releases. A release bumps the version in `package.json`,
`server.json`, and `mcpb/manifest.json`, adds a dated `CHANGELOG.md` entry, and
publishes to npm, Docker Hub, the official MCP registry, and a GitHub release.

## Questions

Open an issue. We are happy to help.
