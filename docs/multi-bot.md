# Multiple bots

Omnicord can drive several Discord bots from a single install, with each
server handled by the bot that is actually in it. You describe an action and
name a server; Omnicord picks the right bot for that server on its own. This
is optional. One bot, set up with a single `DISCORD_TOKEN`, works exactly as
it always has and none of the multi-bot behavior below appears.

If you are an AI assistant reading this to help someone, the short version is:
each server is reached through the bot that is a member of it, tools take an
optional `bot` parameter for the rare cases that need it, and `list_servers`
shows the full map of which bot is in which server.

## When you want this

- A test bot in a sandbox server and a real bot in production, without
  swapping a token every time you cross between them.
- Several communities, each with its own bot, managed from one place.
- One bot per server for permission isolation.

## Setting it up

### With the wizard

Run `npx @orygn/omnicord init`. On a fresh setup it asks how many bots you
want to configure. Answer 1 for the usual single-bot install, or a higher
number to set several up now. For each bot it takes the token, waits for the
privileged intents, asks for a short name to tell the bots apart, and gives
you an invite link for that bot's server.

If you already have a bot configured, `init` instead offers to add another
bot, reconfigure from scratch, or quit. Adding a bot keeps your existing one
and appends the new one, so you can grow into multiple bots one at a time.

### By hand

Multiple bots live in a `bots.json` file next to your `.env` (see
[where config lives](#where-config-lives)). The format is a list of bots,
each with a name and a token, and exactly one marked as the default:

```json
{
  "bots": [
    { "name": "main", "token": "...", "default": true },
    { "name": "test", "token": "..." }
  ]
}
```

Names are how you refer to a bot when you need to be explicit; they are yours
to choose. The default bot is used for actions that are not tied to a server.
A `DISCORD_TOKEN` set in the environment or `.env` still counts as a bot too,
and if its token also appears in `bots.json` the two are recognized as one, so
nothing is loaded twice.

## How routing works

When a tool acts on a server, Omnicord looks at which of your bots is a member
of that server and uses that one. In the normal case of one bot per server
there is nothing to think about: name the server, and the right bot acts.

When a request is ambiguous, Omnicord stops and asks rather than guessing:

- A server name that matches more than one server asks you to be exact.
- A server that more than one of your bots is in asks which bot should act
  (see [choosing a bot explicitly](#choosing-a-bot-explicitly)).
- A server no configured bot is in returns a clear message rather than a
  silent failure.

`list_servers` returns every server across all your bots, each labeled with
the bot that reaches it, which is the map to use when deciding.

## Choosing a bot explicitly

Two kinds of action are not tied to a single server, so they take an optional
`bot` parameter (a bot name) and default to your default bot when it is
omitted:

- `get_bot_info` and `run_setup_check`, which report on a bot itself.
- The rare case where two of your bots share one server and a server-scoped
  action needs to say which bot should act.

Everything else routes by server automatically and needs no `bot` argument.

## Safety with multiple bots

The confirmation gate for destructive actions is bot-aware. When more than one
bot is configured, the preview names the bot and server up front, for example
"Acting as main in Community Server," so a misrouted action shows the wrong
name before anything happens and you can decline. The single-use confirm token
is also bound to the acting bot, so a token issued for one bot cannot be spent
as another. With a single bot, previews and tokens are unchanged.

## When a bot's token goes bad

If one bot's token is reset or otherwise stops working, only that bot is
affected; the others keep routing normally. `list_servers` marks the
unreachable bot so you can spot it, and `run_setup_check` with that bot's name
tells you exactly what is wrong:

```
run a setup check on the "test" bot
```

## Where config lives

Both `.env` and `bots.json` are read from the same directory, in this order of
preference:

1. `OMNICORD_HOME`, if that environment variable is set.
2. The current working directory.
3. The package root (a source checkout) or `~/.omnicord` (an installed copy).

Set `OMNICORD_HOME` to keep all Omnicord config, `.env`, `bots.json`, and saved
data, in one directory of your choosing. It is the same directory the wizard
writes to, so the wizard and the server always agree. `bots.json` holds bot
tokens and should be treated like `.env`: it is gitignored by default.

## One bot stays simple

If you only ever use one bot, you never see any of this. A single
`DISCORD_TOKEN` is one default bot, previews and tokens are byte-for-byte what
they were before, and there is no `bots.json` to think about. Multi-bot is
additive and stays out of the way until you opt in.
