import { createHash, randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ok, fail } from "./envelope.js";
import { getActingBot } from "./discord/actingContext.js";

// The confirmation gate for destructive operations, per tool-catalog 1.4.
//
// Flow: a destructive call without a valid confirm_token does not execute.
// Instead it returns a preview of what would happen plus a short-lived,
// single-use token. Repeating the call with that token executes for real.
// The token is bound to the tool name and the exact resolved arguments, so
// it cannot be minted for one target and spent on another.
//
// Safe mode is on unless OMNICORD_SAFE_MODE=false. With safe mode off,
// destructive calls execute immediately unless dry_run is passed.

const TOKEN_TTL_MS = 2 * 60_000;

interface PendingConfirmation {
  tool: string;
  argsHash: string;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirmation>();

export function safeModeEnabled(): boolean {
  return process.env.OMNICORD_SAFE_MODE?.toLowerCase() !== "false";
}

// Stable hash of the arguments that define the action. Callers pass the
// resolved values (IDs, not fuzzy names) so that the same intent hashes
// the same way regardless of how the user spelled it. When a bot is acting
// (multi-bot setups) it is folded into the hash, so a token minted for one
// bot cannot be spent as another even when the target arguments match.
function hashAction(
  tool: string,
  args: Record<string, unknown>,
  bot?: string
): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join("&");
  const boundBot = bot ? `&__bot=${bot}` : "";
  return createHash("sha256")
    .update(`${tool}?${sorted}${boundBot}`)
    .digest("hex");
}

function sweepExpired(now: number): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

export interface GateInput {
  tool: string;
  // Resolved, canonical arguments identifying the action.
  args: Record<string, unknown>;
  dryRun?: boolean;
  confirmToken?: string;
  // One or two sentences describing exactly what would happen.
  previewSummary: string;
  previewDetails?: unknown;
}

// Returns null when the caller may proceed with the real operation, or a
// finished CallToolResult (preview, token, or rejection) to return as is.
export function gateDestructive(input: GateInput): CallToolResult | null {
  const now = Date.now();
  sweepExpired(now);
  const acting = getActingBot();
  const argsHash = hashAction(input.tool, input.args, acting?.bot);

  if (input.confirmToken) {
    const entry = pending.get(input.confirmToken);
    if (!entry) {
      return fail(
        "That confirm_token is unknown or was already used. Call the tool " +
          "again without a token to get a fresh preview."
      );
    }
    if (entry.expiresAt <= now) {
      pending.delete(input.confirmToken);
      return fail(
        "That confirm_token expired. Call the tool again without a token " +
          "to get a fresh preview."
      );
    }
    if (entry.tool !== input.tool || entry.argsHash !== argsHash) {
      return fail(
        "That confirm_token was issued for a different action. Tokens are " +
          "bound to the exact operation they previewed."
      );
    }
    pending.delete(input.confirmToken);
    return null;
  }

  if (input.dryRun || safeModeEnabled()) {
    const token = randomBytes(16).toString("hex");
    pending.set(token, {
      tool: input.tool,
      argsHash,
      expiresAt: now + TOKEN_TTL_MS,
    });
    const mode = input.dryRun ? "Dry run" : "Safe mode";
    // With more than one bot, name the acting bot and server up front so the
    // human confirming sees exactly which bot would act where. This is the
    // wrong-server backstop: a misrouted action shows the wrong name here.
    const summary = acting
      ? `Acting as ${acting.bot} in ${acting.server}. ${input.previewSummary}`
      : input.previewSummary;
    return ok(
      `${mode}: nothing was changed. ${summary} ` +
        "To execute, call again with the confirm_token.",
      {
        executed: false,
        preview: input.previewDetails ?? null,
        ...(acting ? { acting } : {}),
        confirm_token: token,
        token_expires_in_seconds: TOKEN_TTL_MS / 1000,
      }
    );
  }

  return null;
}

// Exposed for unit tests only: lets tests inspect and age the token store
// without reaching into module internals blindly.
export const __testing = { pending, TOKEN_TTL_MS };
