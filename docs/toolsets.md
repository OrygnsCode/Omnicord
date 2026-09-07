# Toolsets

Omnicord ships 155 tools. Every one of them is described to your AI client
before you type anything, which costs context on every request and gives the
model more options to choose between than most sessions need. The full set is
about 130 KB of JSON, roughly 33,000 tokens.

`OMNICORD_TOOLS` narrows that to the groups you actually use.

This is optional. Leave the variable unset and all 155 tools load, exactly as
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

Size is the group's own weight: the `tools/list` payload with that group
selected, minus the payload of `core` alone.

| Group | Tools | Size | What it covers |
|---|---|---|---|
| `core` | 14 | 9.8 KB | Always on. Diagnostics, setup check, server and channel and role listings, message and member search, `find`. |
| `messaging` | 21 | 23.2 KB | Sending, editing, replies, DMs, reactions, polls, pins, scheduled messages. |
| `moderation` | 17 | 14.7 KB | Bans, kicks, timeouts, prune, the audit log, raid actions, AutoMod rules. |
| `structure` | 23 | 18.8 KB | Channels, roles, and permission overwrites, including locking and cloning. |
| `builder` | 10 | 14.6 KB | Planning a server from a brief, executing plans, blueprints and diffs. |
| `threads` | 8 | 5.3 KB | Threads and their members. |
| `forums` | 8 | 5.8 KB | Forum posts, replies, and tags. |
| `community` | 31 | 20.0 KB | Invites, webhooks, events, stages, emojis, stickers, soundboard. |
| `server` | 19 | 14.9 KB | Server settings, widget, welcome screen, onboarding, templates, bot presence, slash commands. |
| `realtime` | 4 | 2.6 KB | Live gateway event subscriptions. |

## What it saves

Measured from the real `tools/list` response, with tokens approximated at four
bytes each:

| Setting | Tools | Payload | Tokens | Saved |
|---|---|---|---|---|
| unset (everything) | 155 | 132,918 B | ~33,200 | |
| `core` only | 14 | 10,019 B | ~2,500 | 92% |
| `messaging` | 35 | 33,791 B | ~8,400 | 75% |
| `builder` | 24 | 24,954 B | ~6,200 | 81% |
| `messaging,moderation` | 52 | 48,892 B | ~12,200 | 63% |
| `messaging,moderation,structure` | 75 | 68,153 B | ~17,000 | 49% |

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
omnicord v1.4.0 on stdio (toolsets: core, messaging, moderation)
```

## Adding a tool

Every tool must belong to exactly one group. The group map lives in
[`src/toolsets.ts`](../src/toolsets.ts), and the smoke suite fails if a
registered tool has no group, or if a group names a tool that does not exist.
See [CONTRIBUTING.md](../CONTRIBUTING.md).
