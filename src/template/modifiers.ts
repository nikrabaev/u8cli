/**
 * The closed set of template modifiers.
 *
 * Layout modifiers (`pad`, `max`) rewrite the raw text left to right; style
 * modifiers only accumulate a `Style` that the renderer applies at the very end.
 * Separating the two is what lets a row stay column-aligned no matter how many
 * escape sequences the final string carries.
 */
import { displayWidth, isAnsiColor, segmentText, RESET, type AnsiColor, type Style } from "./ansi.js";

/** Truncation marker; counts toward the `max(n)` budget. */
export const ELLIPSIS = "…";

/**
 * Upper bound for `pad()`/`max()`. No terminal is a thousand columns wide, and
 * without a cap a typo like `pad(9999999999)` throws `RangeError` out of the
 * render loop (or quietly allocates a 100 MB row) — a template mistake must stay
 * a load-time warning.
 */
export const MAX_MODIFIER_WIDTH = 1000;

export type Modifier =
  | { kind: "pad"; width: number }
  | { kind: "max"; width: number }
  | { kind: "color"; color: AnsiColor }
  | { kind: "dim" }
  | { kind: "bold" };

export type ModifierParse = { ok: true; modifier: Modifier } | { ok: false; error: string };

/** `pad(24)`, `color(yellow)`, `bold` — no nesting, no quoting. */
const MODIFIER_SYNTAX = /^([A-Za-z]+)(?:\(([^()]*)\))?$/;

/**
 * Parses one `:`-separated modifier segment. Never throws: callers turn the
 * error into a load-time warning and drop the modifier.
 */
export function parseModifier(source: string): ModifierParse {
  const match = MODIFIER_SYNTAX.exec(source);
  if (!match) return { ok: false, error: `malformed modifier ":${source}"` };

  const [, name = "", rawArgs] = match;
  const args = rawArgs === undefined ? [] : rawArgs.split(",").map((a) => a.trim());

  switch (name) {
    case "pad":
    case "max": {
      const width = parseWidth(args);
      if (width === undefined) {
        return { ok: false, error: `${name}() expects an integer width between 0 and ${MAX_MODIFIER_WIDTH}` };
      }
      return { ok: true, modifier: { kind: name, width } };
    }
    case "color": {
      const [color] = args;
      if (args.length !== 1 || color === undefined || color.length === 0) {
        return { ok: false, error: "color() expects one color name" };
      }
      if (!isAnsiColor(color)) return { ok: false, error: `unknown color "${color}"` };
      return { ok: true, modifier: { kind: "color", color } };
    }
    case "dim":
    case "bold": {
      if (rawArgs !== undefined) return { ok: false, error: `${name} takes no arguments` };
      return { ok: true, modifier: { kind: name } };
    }
    default:
      return { ok: false, error: `unknown modifier "${name}"` };
  }
}

export interface StyledText {
  text: string;
  style: Style;
}

/**
 * Applies modifiers in authored order over raw (never styled) text.
 *
 * `base` is the indicator's tone-derived default styling. The first explicit
 * style modifier discards it wholesale rather than merging: once a template
 * author styles a token by hand they own its appearance, so `{version:bold}` on a
 * `muted` value is bold plain text, not bold gray dim.
 */
export function applyModifiers(text: string, modifiers: readonly Modifier[], base: Style): StyledText {
  let out = text;
  let style: Style = { ...base };
  let explicit = false;

  const takeOver = (): void => {
    if (explicit) return;
    style = {};
    explicit = true;
  };

  for (const modifier of modifiers) {
    switch (modifier.kind) {
      case "pad":
        out = padToWidth(out, modifier.width);
        break;
      case "max":
        out = truncateToWidth(out, modifier.width);
        break;
      case "color":
        takeOver();
        style.color = modifier.color;
        break;
      case "dim":
        takeOver();
        style.dim = true;
        break;
      case "bold":
        takeOver();
        style.bold = true;
        break;
    }
  }

  return { text: out, style };
}

/** Right-pads to `width` columns; longer text is left alone (never clipped). */
export function padToWidth(text: string, width: number): string {
  const current = displayWidth(text);
  return current >= width ? text : text + " ".repeat(width - current);
}

/**
 * Truncates to `width` columns, spending the last column on the ellipsis.
 *
 * Escape sequences the *value* carried (a config indicator is arbitrary command
 * stdout, which is routinely colored) pass through whole and cost no columns; a
 * reset is re-appended when the cut discarded the value's own, so a half-eaten
 * SGR cannot bleed into the rest of the row.
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;

  const budget = width - 1;
  let out = "";
  let used = 0;
  let styled = false;
  for (const segment of segmentText(text)) {
    if (used + segment.width > budget) break;
    out += segment.text;
    used += segment.width;
    styled ||= segment.ansi;
  }
  return styled ? `${out}${ELLIPSIS}${RESET}` : `${out}${ELLIPSIS}`;
}

function parseWidth(args: readonly string[]): number | undefined {
  if (args.length !== 1) return undefined;
  const [raw] = args;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const width = Number.parseInt(raw, 10);
  return width > MAX_MODIFIER_WIDTH ? undefined : width;
}
