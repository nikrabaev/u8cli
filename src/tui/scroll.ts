/**
 * Viewport arithmetic for the row list.
 *
 * Pure on purpose: "the cursor must stay visible while the terminal resizes and
 * the list grows under it" is the kind of rule that is obvious until it is off
 * by one, and this way it is tested without a terminal.
 */

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * The first visible row.
 *
 * Scrolls by the least amount that brings `cursor` back into view, so paging
 * through a list keeps the surrounding context instead of re-centring on every
 * step. `prevTop` is the current position, which is what makes it sticky.
 */
export function windowTopFor(cursor: number, total: number, height: number, prevTop: number): number {
  if (height <= 0 || total <= height) return 0;
  const maxTop = total - height;
  let top = clamp(prevTop, 0, maxTop);
  if (cursor < top) top = cursor;
  else if (cursor >= top + height) top = cursor - height + 1;
  return clamp(top, 0, maxTop);
}
