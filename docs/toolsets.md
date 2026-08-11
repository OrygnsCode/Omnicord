# Toolsets

Omnicord ships 151 tools. Every one of them is described to your AI client
before you type anything, which costs context on every request and gives the
model more options to choose between than most sessions need. The full set is
about 120 KB of JSON, roughly 30,000 tokens.

`OMNICORD_TOOLS` narrows that to the groups you actually use.

This is optional. Leave the variable unset and all 151 tools load, exactly as
they always have.

## Using it

Set the variable to a comma separated list of group names:

```
OMNICORD_TOOLS=messaging,moderation
```

In a client configuration:

```json
{
  "mcpServers": {
    "omnicord": {
      "command": "npx",
      "args": ["-y", "@orygn/omnicord"],
      "env": { "OMNICORD_TOOLS": "messaging,moderation" }
    }
  }
}
```

Restart the client afterwards. The tool list is read when the session starts.

## The groups

`core` is always loaded and does not need to be listed. Without it the server
cannot tell you which servers it can reach or whether your setup works, which
makes every other group harder to use.

| Group | Tools | Size | What it covers |
|---|---|---|---|
| `core` | 14 | 10.1 KB | Always on. Diagnostics, setup check, server and channel and role listings, message and member search, `find`. |
| `messaging` | 21 | 17.0 KB | Sending, editing, replies, DMs, reactions, polls, pins, scheduled messages. |
| `moderation` | 17 | 15.2 KB | Bans, kicks, timeouts, prune, the audit log, raid actions, AutoMod rules. |
| `structure` | 23 | 18.8 KB | Channels, roles, and permission overwrites, including locking and cloning. |
| `builder` | 10 | 12.9 KB | Planning a server from a brief, executing plans, blueprints and diffs. |
| `threads` | 8 | 5.5 KB | Threads and their members. |
| `forums` | 8 | 6.1 KB | Forum posts, replies, and tags. |
| `community` | 31 | 20.9 KB | Invites, webhooks, events, stages, emojis, stickers, soundboard. |
| `server` | 15 | 10.5 KB | Server settings, widget, welcome screen, onboarding, templates, bot presence. |
| `realtime` | 4 | 2.7 KB | Live gateway event subscriptions. |

## What it saves

Measured from the real `tools/list` response, with tokens approximated at four
bytes each:

| Setting | Tools | Payload | Tokens | Saved |
|---|---|---|---|---|
| unset (everything) | 151 | 122,597 B | ~30,600 | |
| `core` only | 14 | 10,357 B | ~2,600 | 92% |
| `messaging` | 35 | 27,829 B | ~7,000 | 77% |
| `builder` | 24 | 23,547 B | ~5,900 | 81% |
| `messaging,moderation` | 52 | 43,423 B | ~10,900 | 65% |
| `messaging,moderation,structure` | 75 | 62,646 B | ~15,700 | 49% |

## Choosing a set

- **Running a community day to day**: `messaging,moderation`.
- **Building or restructuring a server**: `builder,structure`.
- **A bot that only posts**: `messaging`.
- **Read only, for reporting or auditing**: `core` on its own.
- **Not sure**: leave it unset. Nothing breaks; you carry the whole surface.

Groups are assigned per tool, not per source file, so a group holds what you
would expect it to hold rather than mirroring the code layout.

## If you get the name wrong

Omnicord refuses to start and tells you which name it did not recognise, along
with the full list of valid groups. It does not quietly load a smaller set,
because tools disappearing without explanation is much harder to debug than a
server that will not boot.

In stdio mode the startup line on stderr also names the active groups, so you
can confirm what a session loaded:

```
omnicord v1.2.1 on stdio (toolsets: core, messaging, moderation)
```

## Adding a tool

Every tool must belong to exactly one group. The group map lives in
[`src/toolsets.ts`](../src/toolsets.ts), and the smoke suite fails if a
registered tool has no group, or if a group names a tool that does not exist.
See [CONTRIBUTING.md](../CONTRIBUTING.md).
