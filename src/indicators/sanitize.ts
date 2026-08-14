/**
 * Indicator values are arbitrary command stdout rendered into fixed-width
 * dashboard rows. One stray newline shifts every row below it, one stray escape
 * sequence recolours the rest of the screen, and one 4 MB value stalls the TUI —
 * so nothing reaches the cache before passing through here.
 */
import { stripAnsi } from "../template/index.js";

/** Hard cap on a cached value, ellipsis included. */
export const MAX_INDICATOR_LENGTH = 200;

/** Truncation marker; matches the template engine's `max()` modifier. */
export const INDICATOR_ELLIPSIS = "…";

/**
 * C0/C1 controls that are *not* whitespace, plus any escape byte left over once
 * whole sequences are gone. Tab, newline, CR, VT and FF are deliberately absent:
 * they are collapsed into spaces a step later, so `"a\nb"` reads as `"a b"`
 * rather than `"ab"`.
 */
const NON_SPACE_CONTROL = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;

const WHITESPACE_RUN = /\s+/g;

/**
 * Collapses one provider result into a single safe display line.
 *
 * Order matters: whole escape sequences first (dropping a lone `ESC` byte would
 * leave its `[31m` payload behind as visible garbage), then the remaining
 * controls, and only then whitespace — collapsing first would leave the spaces
 * that surrounded a stripped control behind as a double space.
 */
export function sanitizeIndicatorText(raw: string): string {
  const flat = stripAnsi(raw).replace(NON_SPACE_CONTROL, "").replace(WHITESPACE_RUN, " ").trim();
  return capLength(flat);
}

function capLength(text: string): string {
  if (text.length <= MAX_INDICATOR_LENGTH) return text;
  let end = MAX_INDICATOR_LENGTH - INDICATOR_ELLIPSIS.length;
  const last = text.charCodeAt(end - 1);
  // Never cut between a surrogate pair — half of an emoji renders as U+FFFD.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${INDICATOR_ELLIPSIS}`;
}
