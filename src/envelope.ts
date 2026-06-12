import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Every Omnicord tool returns the same envelope: a short human-readable
// summary, a lean typed payload, and any non-fatal warnings. The model
// reads the summary; the data is there when it needs specifics. This is
// the convention from docs/tool-catalog.md section 1.5.
export interface Envelope {
  summary: string;
  data: unknown;
  warnings: string[];
}

export function ok(
  summary: string,
  data: unknown = {},
  warnings: string[] = []
): CallToolResult {
  const envelope: Envelope = { summary, data, warnings };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}

export function fail(summary: string, data: unknown = {}): CallToolResult {
  const envelope: Envelope = { summary, data, warnings: [] };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}
