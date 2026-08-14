/**
 * The `?` overlay. It replaces the body rather than floating over it: a terminal
 * has no z-axis, and half a list behind a box of keys is harder to read than
 * either one alone.
 */
import { Box, Text } from "ink";

import { HELP } from "../present.js";
import type { DashboardState } from "../types.js";
import { el, type ReactElement } from "./element.js";

export function Help({ state }: { readonly state: DashboardState }): ReactElement {
  const width = Math.max(...HELP.map((entry) => entry.keys.length));
  // Bound by the same window as the list: a short terminal shows what fits
  // rather than pushing the footer off the screen.
  const visible = HELP.slice(0, Math.max(1, state.viewport));
  return el(
    Box,
    { flexDirection: "column" },
    ...visible.map((entry) =>
      el(
        Text,
        { key: entry.keys, wrap: "truncate-end" },
        el(Text, { color: "cyan" }, `  ${entry.keys.padEnd(width)}`),
        el(Text, { dimColor: true }, `  ${entry.what}`),
      ),
    ),
  );
}
