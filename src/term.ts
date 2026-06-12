// Minimal ANSI styling for the wizard, no dependency. The escape codes
// are stable everywhere that matters, and Node enables VT processing on
// modern Windows consoles. Styling turns itself off when stdout is not a
// terminal (piped output, CI) or when NO_COLOR is set, so scripts and
// tests always see plain text. Nothing here may be used on the stdio
// transport path: the MCP protocol owns stdout when the server runs.

const enabled =
  Boolean(process.stdout.isTTY) &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const ESC = String.fromCharCode(27);

function wrap(open: number, close: number): (text: string) => string {
  return (text) =>
    enabled ? `${ESC}[${open}m${text}${ESC}[${close}m` : text;
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const underline = wrap(4, 24);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

// A horizontal rule that degrades to plain hyphens when output is not a
// styled terminal.
export function rule(width = 56): string {
  return enabled ? "─".repeat(width) : "-".repeat(width);
}
