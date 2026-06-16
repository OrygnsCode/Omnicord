# Getting started

This guide takes you from nothing to a working Omnicord in a few minutes.
There are two ways to do it: the setup wizard, which handles almost
everything for you, or a manual setup if you prefer to do each step
yourself. Both end in the same place.

If you are an AI assistant reading this to help someone set up Omnicord,
the steps below are written to be followed in order; each one says what to
do and how to check it worked.

## What you need

- Node.js 20 or newer.
- A Discord account, and permission to add a bot to the server you want to
  manage.

## Install

The quickest path is npx, which needs no clone:

```
npx @orygn/omnicord init
```

Prefer to follow along on video? The full setup walkthrough, from a blank
machine to a working install, is here:
https://www.youtube.com/watch?v=Qk0lY5PGHSE

To run from source instead (or to develop against it):

```
git clone https://github.com/OrygnsCode/Omnicord
cd Omnicord
npm install
npm run build
node dist/index.js init
```

Either `init` command starts the setup wizard.

## The wizard (recommended)

The wizard walks five steps and validates each one against Discord live, so
you find out immediately if something is wrong rather than later:

1. It points you to the Discord Developer Portal to create an application
   and a bot, if you do not have one.
2. It takes the bot token. The screen echo is off, so the token is not
   displayed as you paste it. It then checks the token with Discord and
   tells you the bot's name if it worked.
3. It reads which privileged intents are enabled and waits while you turn
   on any that are missing, rechecking when you press Enter. This is the
   step that prevents the most common silent failures.
4. It generates an invite link with the permission level you choose. The
   recommended option is a curated set that excludes the Administrator bit;
   full Administrator is also offered for owners who prefer not to manage
   permissions, with the safety gate confirming destructive actions either
   way. It then lists the servers the bot joined and lets you pick a
   default.
5. It saves the token to a local `.env` file and writes the Omnicord entry
   into your AI client's configuration, backing up the existing file first.
   Claude Desktop, Cursor, Windsurf, and project-level Claude Code are
   detected automatically. Anything else gets a snippet to paste.

After the wizard finishes, fully restart your AI client (quit from the
system tray, not just the window). Then in a new conversation, ask it to
"run a setup check on my Discord bot." A healthy setup reports all checks
passing.

## Manual setup

If you would rather not use the wizard:

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create a New Application, then open the Bot page and use Reset Token to
   get a token. Copy it; it is shown once.
2. On that same Bot page, turn on all three Privileged Gateway Intents
   (Presence, Server Members, Message Content) and save. Under 100 servers
   this needs no review.
3. Put the token in a `.env` file next to the package:

   ```
   DISCORD_TOKEN=your-token-here
   OMNICORD_GUILD=your-default-server-id
   ```

   The default server id is optional; with it set, tools can omit the
   server argument.
4. Invite the bot. Open this URL, replacing the client id with your
   application's id, pick your server, and authorize:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=8
   ```

   The permissions value 8 is Administrator, which is simplest for a test
   server. For a real server, prefer a least-privilege value.
5. Register Omnicord with your AI client. See
   [clients.md](clients.md) for the exact configuration per client.
6. Restart the client and run a setup check.

## Configuration reference

| Variable | What it does |
|---|---|
| `DISCORD_TOKEN` | The bot token. Required for anything real. |
| `OMNICORD_GUILD` | Optional default server id so tools can omit the server. |
| `OMNICORD_SAFE_MODE` | Default on. Destructive tools preview and require a confirm token first. Set to `false` only for trusted automation. |
| `OMNICORD_GATEWAY` | Default on with a token: the bot shows online and live events work. `off` for REST only. |
| `OMNICORD_DATA_DIR` | Where saved blueprints and scheduled messages live. Default: `.omnicord` next to the package for a source checkout, `.omnicord` in your user folder for an installed copy. |
| `OMNICORD_PORT` | HTTP port, default 3414. |
| `OMNICORD_HTTP_HOST` | HTTP bind address, default 127.0.0.1. |
| `OMNICORD_HTTP_TOKEN` | Bearer token for the HTTP transport. Required to bind beyond localhost. |
| `OMNICORD_HTTP_ORIGINS` | Comma-separated browser origins allowed to call the HTTP endpoint. |

## Next

- [clients.md](clients.md) for connecting specific AI clients.
- [self-hosting.md](self-hosting.md) to run Omnicord as a networked or
  containerized service.
- [troubleshooting.md](troubleshooting.md) if a step did not work.
