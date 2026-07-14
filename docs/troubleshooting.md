# Troubleshooting

Common problems and their fixes. The fastest diagnostic is to ask your AI
to run a setup check; it reports each part of the setup and how to fix what
is wrong. If you are an AI assistant helping someone, run that check first
and read the results back.

## The tools do not appear in my AI client

Almost always the client needs a full restart to pick up a new MCP server.
Quit it completely (from the system tray on desktop apps, not just the
window) and reopen. Then start a fresh conversation. If it still does not
appear, confirm the configuration file is the one the client actually
reads and that the path to `dist/index.js` is correct and absolute.

## Setup check says the token is missing or invalid

- Missing: there is no `DISCORD_TOKEN`. Put it in a `.env` file next to the
  package (source checkouts), in `.omnicord/.env` in your user folder
  (installed copies; the wizard writes it there), or in the client's
  server configuration environment.
- Invalid: Discord rejected the token. It is wrong, expired, or was reset.
  Generate a fresh one on the Bot page in the Developer Portal and update
  `DISCORD_TOKEN`.

## Setup check says an intent is disabled

Member search and message reading need the Server Members and Message
Content intents. Open your application's Bot page in the Developer Portal,
scroll to Privileged Gateway Intents, turn the missing ones on, and save.
Under 100 servers this needs no review. Then run the check again.

## The bot shows as offline

If you are using the default (gateway on), the bot shows online whenever an
Omnicord process is running and connected. A short delay at startup is
normal while it connects. If it stays offline, run a setup check and read
the gateway line. Note that the bot can still do everything over REST even
when it appears offline; the online dot is presence, not capability. If you
set `OMNICORD_GATEWAY=off`, the bot is intentionally offline.

## An action went to the wrong bot, or a bot is unreachable

These apply only when you run more than one bot (see
[Multiple bots](multi-bot.md)).

- Wrong server, or "no bot in that server": Omnicord routes by which bot is
  a member of the named server. Ask it to "list servers" to see the map of
  which bot reaches which server. If a server is not listed, no configured
  bot is in it; invite one, or check the name.
- Ambiguous: if two of your bots share one server, name the bot to use (for
  example "as the main bot") so Omnicord does not have to guess.
- A bot is unreachable: if one bot's token was reset, only that bot stops
  working, and `list_servers` flags it. Run a setup check on that bot by
  name ("run a setup check on the test bot") to see what is wrong, then fix
  its token in `bots.json`.

## A tool fails with a permissions error

The bot is missing a Discord permission, or its role is too low. Omnicord
preflights most of these and tells you the exact permission and where to
grant it. Two frequent causes:

- The bot's highest role is below the role or member it is trying to act
  on. Move the bot's role higher in Server Settings, Roles.
- The bot lacks a permission in that specific channel because of a channel
  permission override. Grant it on the channel, or use the
  explain_permissions tool to see exactly why an action is blocked.

## Creating a forum, announcement, or stage channel fails

Announcement and stage channels require the server to have the Community
feature enabled (Server Settings, Enable Community). Forum channels work
without it. You can enable Community through Omnicord with the update_server
tool, which also sets the channels Community requires.

## A destructive action did not happen

That is the safety gate working as intended. Destructive tools preview
first and return a confirmation token; the action only runs when the call
is repeated with that token. Your AI should show you the preview and ask
before confirming. If you want a tool to execute immediately without the
gate in a trusted automated setup, set `OMNICORD_SAFE_MODE=false`.

## Calls time out or feel slow

- A burst of writes can queue behind Discord's rate limits. Omnicord waits
  politely rather than risking a ban, so a heavy sequence can take tens of
  seconds. The get_rate_limit_status tool shows what has been happening.
- Connection timeouts that mention a Cloudflare address are usually local
  network trouble between you and Discord, not Omnicord or Discord itself.
  Retrying the same call typically works.

## Member pruning says the allowance is used up

Discord limits how often a server can run a real prune to a few times every
several minutes. The preview count is not limited, so you can always check
how many members would be removed; the execution simply needs to wait a few
minutes between runs.

## Tools broke after cleaning the npm cache

If Omnicord was installed with npx, the program itself lives in npm's
cache folder, and `npm cache clean --force` deletes it. Your token and
saved data are safe: they live in `.omnicord` in your user folder, which
a cache clean does not touch. To repair, run the same install command
again:

```
npx @orygn/omnicord init
```

The wizard re-registers the fresh copy with your AI client. Then fully
restart the client.

## The HTTP server refuses to start

If you bind to a non-localhost address without `OMNICORD_HTTP_TOKEN`,
Omnicord refuses to start on purpose, so the bot is never exposed to a
network without authentication. Set a strong `OMNICORD_HTTP_TOKEN`, or bind
to 127.0.0.1 for local-only use.

## Still stuck

Open an issue on the repository with what you tried and what the setup
check reported. For a security concern specifically, email
security@orygn.tech rather than posting it publicly.
