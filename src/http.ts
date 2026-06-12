import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, type OmnicordConfig } from "./config.js";
import { buildServer } from "./server.js";

// Streamable HTTP transport with a security posture that matches what
// this server can do. A Discord bot token sits behind this endpoint, so
// the rules are strict and on by default:
//
// - Binding beyond loopback requires OMNICORD_HTTP_TOKEN. The process
//   refuses to start on a public interface without one, instead of
//   quietly exposing the bot to the network.
// - When a token is set, every /mcp request needs Authorization: Bearer,
//   compared in constant time.
// - Requests carrying a browser Origin header are rejected unless the
//   origin is allowlisted via OMNICORD_HTTP_ORIGINS. Non-browser MCP
//   clients send no Origin; a browser page driving this API cross-site
//   is exactly the DNS rebinding attack the MCP spec says to block.
// - In loopback mode the Host header must also be a loopback name, which
//   closes the rebinding hole where an attacker's domain resolves to
//   127.0.0.1.

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SESSIONS = 64;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

interface Session {
  transport: StreamableHTTPServerTransport;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startHttpServer(
  config: OmnicordConfig,
  options: { port: number; host: string }
): void {
  const authToken = process.env.OMNICORD_HTTP_TOKEN?.trim() || undefined;
  const allowedOrigins = new Set(
    (process.env.OMNICORD_HTTP_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  );
  const loopback = LOOPBACK_HOSTS.has(options.host);

  if (!loopback && !authToken) {
    console.error(
      `Refusing to bind to ${options.host} without authentication. A bot ` +
        "token sits behind this endpoint. Set OMNICORD_HTTP_TOKEN to a " +
        "strong secret to serve beyond localhost, or bind to 127.0.0.1."
    );
    process.exit(1);
  }

  const sessions = new Map<string, Session>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        name: "omnicord",
        version: VERSION,
        sessions: sessions.size,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found; the MCP endpoint is /mcp" });
      return;
    }

    // Origin gate: browser pages do not get to drive this API cross-site.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      rpcError(res, 403, "Origin not allowed.");
      return;
    }

    // Host gate in loopback mode, against DNS rebinding.
    if (loopback && !authToken) {
      const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK_HOSTS.has(hostName)) {
        rpcError(res, 403, "Host header must be a loopback address.");
        return;
      }
    }

    if (authToken) {
      const presented = bearerToken(req);
      if (!presented || !constantTimeEquals(presented, authToken)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing or invalid bearer token." },
            id: null,
          })
        );
        return;
      }
    }

    let parsedBody: unknown;
    if (req.method === "POST") {
      try {
        const raw = await readBody(req);
        parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch (err) {
        const tooBig = err instanceof Error && err.message === "body too large";
        rpcError(res, tooBig ? 413 : 400, tooBig ? "Body too large." : "Invalid JSON.");
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (typeof sessionId === "string" && !existing) {
      rpcError(res, 404, "Unknown or expired session. Initialize again.");
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
      rpcError(res, 400, "No session. Send an initialize request first.");
      return;
    }

    if (sessions.size >= MAX_SESSIONS) {
      rpcError(res, 429, "Too many concurrent sessions.");
      return;
    }

    // New session: one transport and one server instance per session.
    // JSON responses rather than SSE for POSTs keeps simple clients
    // simple; the standalone GET stream still serves notifications.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = buildServer(config);
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  });

  httpServer.listen(options.port, options.host, () => {
    console.error(
      `omnicord v${VERSION} on http://${options.host}:${options.port}/mcp ` +
        (authToken
          ? "(bearer auth required)"
          : "(loopback only, no auth token set)") +
        (config.token ? "" : " (no DISCORD_TOKEN set, diagnostics will say so)")
    );
  });

  const shutdown = async () => {
    const { stopGateway } = await import("./discord/gateway.js");
    await stopGateway();
    for (const [, session] of sessions) {
      await session.transport.close().catch(() => undefined);
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
