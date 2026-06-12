#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, VERSION } from "./config.js";
import { buildServer } from "./server.js";
import { startHttpServer } from "./http.js";

// Entry point. Two transports:
//
//   omnicord                 stdio, the default; for desktop MCP clients
//   omnicord --http          Streamable HTTP on 127.0.0.1:3414
//
// One hard rule in stdio mode and everything it pulls in: nothing writes
// to stdout except the MCP protocol itself. Logs go to stderr.

function parseArgs(argv: string[]): {
  http: boolean;
  port: number;
  host: string;
} {
  const args = argv.slice(2);
  const http = args.includes("--http");
  const portFlag = args.indexOf("--port");
  const hostFlag = args.indexOf("--host");

  const port =
    portFlag !== -1
      ? Number(args[portFlag + 1])
      : Number(process.env.OMNICORD_PORT ?? 3414);
  const host =
    hostFlag !== -1
      ? args[hostFlag + 1]
      : process.env.OMNICORD_HTTP_HOST ?? "127.0.0.1";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port "${port}". Use --port 1..65535.`);
    process.exit(1);
  }
  return { http, port, host };
}

// The init subcommand runs the interactive setup wizard and exits.
if (process.argv[2] === "init") {
  const { runWizard } = await import("./wizard.js");
  await runWizard();
  process.exit(0);
}

const config = loadConfig();
const { http, port, host } = parseArgs(process.argv);

// The gateway connects in the background: presence goes online and event
// subscriptions start flowing, while the transports come up immediately.
// A gateway failure degrades to REST-only and shows up in diagnostics.
const { startGateway } = await import("./discord/gateway.js");
void startGateway(config);

// The message scheduler ticks in the background, catching up anything that
// came due while the process was down and firing the rest on time.
const { startScheduler } = await import("./scheduler.js");
startScheduler(config);

if (http) {
  startHttpServer(config, { port, host });
} else {
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `omnicord v${VERSION} on stdio` +
      (config.token ? "" : " (no DISCORD_TOKEN set, diagnostics will say so)")
  );
}
