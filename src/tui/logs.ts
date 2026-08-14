/**
 * Scrollback for the log view: a bounded buffer plus the window the renderer
 * draws.
 *
 * Two constraints shape it, both from a chatty dev server:
 *
 *  - **Memory is capped.** A `pnpm dev` that prints all night must not grow the
 *    TUI without limit, so the buffer keeps the newest {@link LogViewState.lines}
 *    and counts what it dropped.
 *  - **Scroll position is not an array index.** Eviction shifts every index, so
 *    a paused view anchors on the monotonic `seq` of its top line and survives
 *    both eviction and appends. Following views need no anchor at all: they are
 *    defined as "the last `height` lines".
 */
import type { LogLine } from "../ipc/protocol.js";
import type { LogEntry, LogViewState } from "./types.js";
import { clamp } from "./scroll.js";

/** Appends a batch, evicting from the front. Returns the next free sequence. */
export function appendLogLines(
  view: LogViewState,
  lines: readonly LogLine[],
  cap: number,
  nextSeq: number,
): number {
  let seq = nextSeq;
  for (const line of lines) {
    view.lines.push({
      seq: seq++,
      targetId: line.targetId,
      stream: line.stream,
      ts: line.ts,
      text: line.text,
    });
  }
  const excess = view.lines.length - Math.max(1, cap);
  if (excess > 0) {
    view.lines.splice(0, excess);
    view.dropped += excess;
  }
  return seq;
}

export interface LogWindow {
  lines: LogEntry[];
  /** Index of the first visible line within the buffer. */
  top: number;
  total: number;
  /** True when the window ends at the newest line — the follow position. */
  atBottom: boolean;
}

export function logWindow(view: LogViewState, height: number): LogWindow {
  const total = view.lines.length;
  const size = Math.max(1, height);
  const maxTop = Math.max(0, total - size);
  const top = view.follow ? maxTop : clamp(indexOfSeq(view, view.topSeq), 0, maxTop);
  return {
    lines: view.lines.slice(top, top + size),
    top,
    total,
    atBottom: top >= maxTop,
  };
}

/**
 * Moves the view by `delta` lines. Scrolling up pauses follow; reaching the
 * bottom resumes it, so "scroll back down" and "resume following" are one
 * gesture rather than two.
 */
export function scrollLogView(view: LogViewState, delta: number, height: number): void {
  const size = Math.max(1, height);
  const maxTop = Math.max(0, view.lines.length - size);
  const current = view.follow ? maxTop : clamp(indexOfSeq(view, view.topSeq), 0, maxTop);
  const next = clamp(current + delta, 0, maxTop);
  if (next >= maxTop) {
    view.follow = true;
    view.topSeq = undefined;
    return;
  }
  view.follow = false;
  view.topSeq = view.lines[next]?.seq;
}

export function logViewTop(view: LogViewState): void {
  view.follow = view.lines.length === 0;
  view.topSeq = view.lines[0]?.seq;
}

export function logViewBottom(view: LogViewState): void {
  view.follow = true;
  view.topSeq = undefined;
}

/** Index of the anchored line; the oldest surviving line once it is evicted. */
function indexOfSeq(view: LogViewState, seq: number | undefined): number {
  if (seq === undefined) return 0;
  const first = view.lines[0];
  if (first === undefined) return 0;
  // Sequences are dense and ascending, so the offset is arithmetic, not a scan.
  return clamp(seq - first.seq, 0, view.lines.length - 1);
}
