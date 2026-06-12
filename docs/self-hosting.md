# Self-hosting

Run Omnicord as a networked service or a container when you want it always
on (so scheduled messages fire and live events keep flowing while your
computer is off), or when your AI client connects to remote MCP servers
rather than launching local ones.

## The HTTP transport

Start Omnicord in HTTP mode:

```
node dist/index.js --http              # 127.0.0.1:3414/mcp
node dist/index.js --http --port 8080
```

The MCP endpoint is at `/mcp`. A health endpoint is at `/healthz` and
reports the version and live session count.

## Security model, on by default

A bot token sits behind this endpoint, so the defaults are strict and you
should understand them:

- Binding to anything other than localhost without `OMNICORD_HTTP_TOKEN`
  refuses to start. This prevents accidentally exposing the bot to a
  network. The error message names the fix.
- With a token set, every request to `/mcp` must send
  `Authorization: Bearer <token>`. The comparison is constant time.
- Requests that carry a browser `Origin` header are rejected unless the
  origin is in `OMNICORD_HTTP_ORIGINS`. In localhost mode the `Host` header
  is validated too. Together these close the DNS-rebinding path that lets a
  web page reach a service on your machine.
- Concurrent sessions and request body size are capped.

When you serve beyond localhost, always set a strong `OMNICORD_HTTP_TOKEN`
and put the service behind TLS, for example with a reverse proxy such as
Caddy or nginx. The token authenticates; TLS keeps it private in transit.

Example:

```
OMNICORD_HTTP_TOKEN=a-long-random-secret \
  node dist/index.js --http --host 0.0.0.0 --port 8080
```

## Docker

The image runs the HTTP transport as a non-root user and wires the
container health check to `/healthz`. Because it binds beyond localhost, it
requires `OMNICORD_HTTP_TOKEN` and exits with a clear message without one.
The token never lives in the image; it arrives through the environment at
run time.

Build and run:

```
docker build -t omnicord .
docker run -d -p 3414:3414 \
  -e DISCORD_TOKEN=your-bot-token \
  -e OMNICORD_HTTP_TOKEN=a-long-random-secret \
  -e OMNICORD_GUILD=your-default-server-id \
  omnicord
```

Or with compose, after exporting the secrets in your shell or an env file:

```
docker compose up -d
```

## Persistent data

Saved blueprints and scheduled messages are stored as JSON files under the
data directory, which can be moved with `OMNICORD_DATA_DIR`. The default
is a `.omnicord` folder next to the package for a source checkout, or
`.omnicord` in the user folder for an installed copy. To keep the data
across container restarts, mount that directory as a volume.

## Connecting a remote client

Point your client's remote MCP configuration at
`http://your-host:port/mcp` with the bearer token. The client performs the
normal MCP initialize handshake; Omnicord issues a session and the rest
works exactly as it does locally. For a hosted, zero-setup version of this
without running anything yourself, see the project roadmap.
