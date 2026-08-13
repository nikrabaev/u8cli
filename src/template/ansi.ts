/**
 * Zero-dependency ANSI styling for row templates.
 *
 * Styling is kept strictly separate from layout: modifiers rewrite raw text and
 * this module wraps the finished string exactly once. That ordering is what keeps
 * `pad()`/`max()` honest — u8's own escape bytes only appear after every width is
 * final, and escapes a *value* brought with it are measured as zero columns.
 */

export const ANSI_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
] as const;

export type AnsiColor = (typeof ANSI_COLORS)[number];

/** Composed styling for one token; absent fields mean "leave alone". */
export interface Style {
  color?: AnsiColor;
  dim?: boolean;
  bold?: boolean;
}

const FOREGROUND: Record<AnsiColor, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

const BOLD = 1;
const DIM = 2;

export const RESET = "\x1b[0m";

/** Matches CSI (colors, cursor moves) and OSC (hyperlinks, window title) sequences. */
const ANSI_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\))`;
const ANSI_PATTERN = new RegExp(ANSI_SOURCE, "g");
/** Sticky twin used to scan sequence-by-sequence; `lastIndex` is set before every exec. */
const ANSI_AT = new RegExp(ANSI_SOURCE, "y");

const ESC = 0x1b;

/** Combining marks and format controls occupy no column of their own. */
const ZERO_WIDTH = /^[\p{M}\p{Cf}]$/u;

export function isAnsiColor(name: string): name is AnsiColor {
  return (ANSI_COLORS as readonly string[]).includes(name);
}

export function isEmptyStyle(style: Style): boolean {
  return style.color === undefined && !style.dim && !style.bold;
}

/** Wraps `text` in a single SGR pair. No-op for empty text or empty styles. */
export function applyStyle(text: string, style: Style): string {
  if (text.length === 0 || isEmptyStyle(style)) return text;
  const codes: number[] = [];
  if (style.bold) codes.push(BOLD);
  if (style.dim) codes.push(DIM);
  if (style.color !== undefined) codes.push(FOREGROUND[style.color]);
  return `\x1b[${codes.join(";")}m${text}${RESET}`;
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/** One scan unit: a whole escape sequence, or a single code point. */
export interface TextSegment {
  text: string;
  /** Columns occupied — 0 for escape sequences and combining marks. */
  width: number;
  /** Escape sequences must survive truncation whole; slicing one corrupts the row. */
  ansi: boolean;
}

/**
 * Walks a string as escape sequences + code points.
 *
 * Width math and truncation both consume this, so there is exactly one answer to
 * "does this occupy a column" — the bug it prevents is `max()` slicing a value's
 * own SGR sequence in half and counting its bytes as columns.
 */
export function* segmentText(s: string): Generator<TextSegment> {
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === ESC) {
      ANSI_AT.lastIndex = i;
      const match = ANSI_AT.exec(s);
      if (match) {
        yield { text: match[0], width: 0, ansi: true };
        i += match[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    yield { text: ch, width: ZERO_WIDTH.test(ch) ? 0 : 1, ansi: false };
    i += ch.length;
  }
}

/**
 * Visible column count.
 *
 * Known limitation: East-Asian wide characters and emoji are counted as one
 * column each, so rows containing them can under-pad. Fixing that needs a width
 * table (or grapheme segmentation) which v1 deliberately skips — every indicator
 * value u8 renders today is ASCII-ish.
 */
export function displayWidth(s: string): number {
  let width = 0;
  for (const segment of segmentText(s)) width += segment.width;
  return width;
}
