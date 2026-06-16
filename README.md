# Omnicord

[![CI](https://github.com/OrygnsCode/Omnicord/actions/workflows/ci.yml/badge.svg)](https://github.com/OrygnsCode/Omnicord/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40orygn%2Fomnicord)](https://www.npmjs.com/package/@orygn/omnicord)
[![Glama score](https://glama.ai/mcp/servers/OrygnsCode/Omnicord/badges/score.svg)](https://glama.ai/mcp/servers/OrygnsCode/Omnicord)
[![License: Elastic 2.0](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-8A2BE2)](docs/clients.md)

Omnicord is an MCP server that gives your AI assistant full operational
control of a Discord server. Day to day chat, moderation, administration,
and at the top end: building out an entire community server from a one
paragraph brief.

You describe what you want. Your AI decides how to do it. Omnicord makes
sure it happens correctly, and that nothing destructive happens without
your say so.

## How it works

Your AI client (Claude Desktop, Cursor, Windsurf, Claude Code, or any
other MCP client) is the brain. Omnicord is the hands: it talks to
Discord through your own bot, enforces Discord's rules before they bite,
queues politely behind rate limits, and gates every destructive action
behind a preview you confirm. There is no LLM inside Omnicord and no
cloud service behind it. Your bot token stays in a file on your machine.

## Quick start

You need Node 20 or newer and a Discord account. One command:

```
npx @orygn/omnicord init
```

Or from source:

```
git clone https://github.com/OrygnsCode/Omnicord.git && cd Omnicord
npm install
npm run build
node dist/index.js init
```

Prefer to watch? Here is the full setup, start to finish:

[![Omnicord setup walkthrough](https://img.youtube.com/vi/Qk0lY5PGHSE/hqdefault.jpg)](https://www.youtube.com/watch?v=Qk0lY5PGHSE)

The wizard goes from a bare Discord application to a working setup in
about a minute. It takes the bot token with input hidden, verifies it
live against Discord, checks the privileged intent toggles and waits
while you fix any that are off, generates an invite link at the
permission level you pick, saves the token locally (a gitignored `.env`
for a source checkout, or `.omnicord/.env` in your user folder for an
npx or global install), and writes the omnicord entry into your AI
client's config (backing the file up first). Claude Desktop (including the Microsoft Store build), Cursor,
Windsurf, and project level Claude Code are detected automatically;
anything else gets a snippet to paste.

Then fully restart your AI client and ask it:

> run a setup check on my Discord bot

Eight checks, plain English results, and the exact fix for anything that
is wrong.

## What it can do

| Area | Examples |
|---|---|
| Server building | Plan and execute a full server build from a brief: roles, categories, channels, permissions, in one additive operation. Save, diff, and rebuild layouts as blueprints. |
| Messaging | Send, edit, pin, react, polls, scheduled messages, DMs, webhooks. |
| Reading | Channel history, search, members, roles, permissions, audit log. |
| Moderation | Timeouts, kicks, bans, bulk actions, prune, all preview first. |
| AutoMod | Discord's server side filters: keyword rules, Discord maintained preset lists (slurs, profanity), spam and mention flood limits. |
| Real time | Subscribe to live server events and ask "what did I miss?" |
| Structure | Channels, categories, permission overwrites, reordering, cloning. |
| Community | Events, stages, threads, forums, invites, welcome screen, onboarding. |
| Expression | Emojis, stickers, soundboard sounds. |
| Diagnostics | Setup check, bot info, rate limit status, permission explainers. |

The full contract for every tool is in the
[tool catalog](docs/tool-catalog.md).

## The safety model

Destructive operations (deleting, banning, kicking, timeouts, bulk
actions) never execute on the first call. They return a human readable
preview and a confirmation token bound to that exact action; repeating
the call with the token executes it. Tokens are single use and expire
after two minutes. Moderation additionally preflights Discord's
hierarchy rules, owner protection, and self protection before the gate,
so the failure mode is an explanation rather than a 403.

This is enforced by Omnicord itself, not by the model's judgment. A
confused or compromised AI session cannot skip the gate.

## Running it

Stdio, the default, for desktop MCP clients:

```
node dist/index.js
```

Streamable HTTP, for remote capable clients and self hosting:

```
node dist/index.js --http              # 127.0.0.1:3414/mcp
node dist/index.js --http --port 8080
```

A bot token sits behind the HTTP endpoint, so the defaults are strict:
binding beyond localhost without `OMNICORD_HTTP_TOKEN` refuses to start,
bearer auth is compared in constant time, browser origins are rejected
unless allowlisted, and the Host header is validated in loopback mode to
close DNS rebinding. Details in [self-hosting](docs/self-hosting.md).

## Docker

A published image is on Docker Hub (`orygn/omnicord`), or you can build
your own. The image runs the HTTP transport as a non root user with the
container health check wired to the health endpoint. It binds beyond
loopback, so it requires `OMNICORD_HTTP_TOKEN` and exits with a clear
message without one. The token never lives in the image; everything
arrives through the environment at runtime.

```
docker run -d -p 3414:3414 \
  -e DISCORD_TOKEN=your-bot-token \
  -e OMNICORD_HTTP_TOKEN=a-strong-secret \
  orygn/omnicord
```

To build it yourself instead: `docker build -t omnicord .`. Or with
compose, after exporting the two secrets: `docker compose up -d`.

## Configuration

Environment variables, or a `.env` file (the wizard writes one for you;
source checkouts use `.env` next to `package.json`, npx and global
installs use `.omnicord/.env` in your user folder):

| Variable | What it does |
|---|---|
| `DISCORD_TOKEN` | The bot token. Required for anything real; the server boots without it and the diagnostics explain what to fix. |
| `OMNICORD_GUILD` | Optional default server ID so tools can omit the guild parameter. |
| `OMNICORD_SAFE_MODE` | Default on. Destructive tools preview first and require a confirm token; set to `false` only for trusted automation. |
| `OMNICORD_GATEWAY` | Default on when a token is set: the bot shows as online and real time event subscriptions work. Set to `off` for REST only operation. |
| `OMNICORD_DATA_DIR` | Where saved blueprints and scheduled messages live. Default: `.omnicord` next to `package.json` for a source checkout, `.omnicord` in your user folder for an installed copy. |
| `OMNICORD_PORT` | HTTP port, default 3414. |
| `OMNICORD_HTTP_HOST` | HTTP bind address, default `127.0.0.1`. |
| `OMNICORD_HTTP_TOKEN` | Bearer token for HTTP mode. Required to bind beyond localhost. |
| `OMNICORD_HTTP_ORIGINS` | Comma separated browser origins allowed to call the HTTP endpoint. Empty means none. |

Client config for stdio (Claude Desktop and compatible):

```json
{
  "mcpServers": {
    "omnicord": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

No token goes in the client config. The server finds `.env` no matter
where the client spawns it from: it checks the current directory, then
the package root, then `.omnicord` in your user folder, and a real
environment variable overrides all of them.

## Documentation

| Doc | What is in it |
|---|---|
| [Getting started](docs/getting-started.md) | Setup in a few minutes, wizard or by hand. |
| [Connecting AI clients](docs/clients.md) | Exact config for Claude Desktop, Claude Code, Cursor, Windsurf, ChatGPT, and anything else. |
| [Self-hosting](docs/self-hosting.md) | HTTP transport, Docker, and the security model for networked deployments. |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and their fixes. |
| [Security whitepaper](docs/security-whitepaper.md) | Plain language: what Omnicord can and cannot touch, for whoever decides whether to install it. |
| [SECURITY.md](SECURITY.md) | The engineering level threat model and audit findings. |
| [Tool catalog](docs/tool-catalog.md) | The full contract of all 148 tools. |

The docs are written to be read by AI assistants too: paste a page at
your AI and have it walk you through.

Omnicord is also listed on the
[official MCP registry](https://registry.modelcontextprotocol.io),
[Smithery](https://smithery.ai/servers/orygn/omnicord), and
[Docker Hub](https://hub.docker.com/r/orygn/omnicord).

## Tests

```
node scripts/unit.mjs        # pure logic: resolver, permissions, planner, gate
node scripts/smoke.mjs       # stdio protocol session, no token needed
node scripts/smoke-http.mjs  # HTTP transport, sessions, auth, security gates
node scripts/acceptance.mjs  # live end-to-end against a real test server
```

The acceptance suite needs `DISCORD_TOKEN` and `OMNICORD_GUILD` pointing
at a disposable test server, and cleans up after itself.
`scripts/smoke-docker.mjs` builds and verifies the container image and
needs a running Docker daemon.

## License

Omnicord is source available under the
[Elastic License 2.0](LICENSE). In plain terms: anyone may read, use,
modify, and self host it freely, including businesses running their own
communities. The one thing the license forbids is offering Omnicord to
third parties as a hosted or managed service. The code is public so it
can be audited; it is not up for resale as a service.

## Versioning

Semantic versioning, tracked in [CHANGELOG.md](CHANGELOG.md). 1.0.0
marked the public launch; releases since follow semver, and the npm
badge above shows the current version. The version in `package.json`
flows everywhere automatically: the MCP server identity, the health
endpoint, and the wizard.

Built by [Orygn LLC](https://orygn.tech). Security reports:
security@orygn.tech.
