/**
 * Presentation helpers shared by every subcommand: the colour decision, a tiny
 * styler, column layout, and the words a task result is reported with.
 *
 * Styling reuses `template/ansi` rather than growing a second escape-code
 * vocabulary, so a summary table and a status row painted by the template engine
 * agree on what "yellow" means — and widths are measured with `displayWidth`,
 * which counts escape sequences as zero columns.
 */
import { applyStyle, displayWidth, padToWidth, type AnsiColor, type Style } from "../template/index.js";
import type { TaskTargetState } from "../ipc/protocol.js";
import type { CliIo } from "./io.js";

/**
 * Whether to emit ANSI at all.
 *
 * Precedence, most explicit first: `--no-color`, then `NO_COLOR` (any non-empty
 * value, per no-color.org), then `FORCE_COLOR` (which is how a CI job that
 * *wants* colour in a captured log asks for it), then "stdout is a terminal".
 */
export function shouldUseColor(io: CliIo, flag: boolean | undefined): boolean {
  if (flag === false) return false;
  const no = io.env["NO_COLOR"];
  if (no !== undefined && no !== "") return false;
  const force = io.env["FORCE_COLOR"];
  if (force !== undefined && force !== "" && force !== "0") return true;
  return io.tty;
}

export interface Styler {
  readonly enabled: boolean;
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

export function createStyler(enabled: boolean): Styler {
  const paint = (style: Style) => (s: string) => (enabled ? applyStyle(s, style) : s);
  const color = (name: AnsiColor) => paint({ color: name });
  return {
    enabled,
    dim: paint({ dim: true }),
    bold: paint({ bold: true }),
    red: color("red"),
    green: color("green"),
    yellow: color("yellow"),
    cyan: color("cyan"),
    gray: color("gray"),
  };
}

// ---------------------------------------------------------------------------
// Task vocabulary
// ---------------------------------------------------------------------------

/** One glyph per outcome. ASCII-adjacent on purpose: these end up in CI logs. */
export const STATE_SYMBOL: Record<TaskTargetState, string> = {
  pending: "·",
  running: "…",
  skipped: "-",
  ok: "✓",
  failed: "✗",
  aborted: "!",
};

export function paintState(style: Styler, state: TaskTargetState, text: string): string {
  switch (state) {
    case "ok":
      return style.green(text);
    case "failed":
    case "aborted":
      return style.red(text);
    case "skipped":
      return style.dim(text);
    default:
      return style.cyan(text);
  }
}

/** `120ms`, `1.4s`, `2m3s` — two significant units at most, like `app@uptime`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m${whole % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Errors reach the terminal as one row cell; newlines would break the table. */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableOptions {
  /** Cells may already carry ANSI; widths are measured, not counted. */
  head?: readonly string[];
  /** Two spaces reads better than a pipe in a terminal that is already dense. */
  gap?: string;
  indent?: string;
}

/**
 * Left-aligned columns sized to their content. Returns lines rather than a
 * blob so the caller decides where they go (stdout rows, stderr diagnostics).
 */
export function renderTable(rows: ReadonlyArray<readonly string[]>, opts: TableOptions = {}): string[] {
  const all = opts.head ? [opts.head, ...rows] : rows;
  if (all.length === 0) return [];
  const columns = Math.max(...all.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < columns; i++) {
    widths[i] = Math.max(...all.map((r) => displayWidth(r[i] ?? "")));
  }

  const gap = opts.gap ?? "  ";
  const indent = opts.indent ?? "";
  return all.map((row) => {
    const cells: string[] = [];
    for (let i = 0; i < columns; i++) {
      const cell = row[i] ?? "";
      // The last column is never padded: trailing whitespace is noise in a diff
      // and in a `| grep`.
      cells.push(i === columns - 1 ? cell : padToWidth(cell, widths[i] ?? 0));
    }
    return `${indent}${cells.join(gap).trimEnd()}`;
  });
}
