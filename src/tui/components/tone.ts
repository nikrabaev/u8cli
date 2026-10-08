/**
 * How a toned line is painted, in one place.
 *
 * The report, the detail view and a confirmation all draw the same kind of
 * line, and "red means this is what you lose" has to mean it in all three.
 */
import { Text } from "ink";

import type { LineTone, ToneLine } from "../types.js";
import { el, type ReactElement } from "./element.js";

interface Paint {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

const PAINT: Record<LineTone, Paint> = {
  plain: {},
  title: { bold: true },
  ok: { color: "green" },
  warn: { color: "yellow" },
  error: { color: "red" },
  dim: { dimColor: true },
};

/**
 * One line, already wrapped by whoever built it. An empty one is drawn as a
 * space: Ink gives a `<Text>` with nothing in it no height, and the blank line
 * between a failure and its log tail is part of how the panel reads.
 */
export function toneLine(line: ToneLine, key: string | number): ReactElement {
  return el(Text, { key, wrap: "truncate-end", ...PAINT[line.tone] }, line.text.length === 0 ? " " : line.text);
}
