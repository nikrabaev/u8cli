/**
 * The main list: repo header rows with their app rows beneath, windowed to
 * whatever the terminal has room for.
 *
 * The row text arrives pre-rendered from the template engine (ANSI and all), so
 * this component only adds the two things a static `u8 status` cannot have: the
 * cursor, and the per-target progress of a run in flight.
 */
import { Box, Text } from "ink";

import { progressLabel } from "../present.js";
import type { DashboardState } from "../types.js";
import { el, type ReactElement } from "./element.js";

/** Marks the selected row. Two columns wide on every row, so nothing shifts. */
const CURSOR = "❯ ";
const NO_CURSOR = "  ";

export function RowList({ state }: { readonly state: DashboardState }): ReactElement {
  if (state.rows.length === 0) {
    return el(
      Box,
      { flexDirection: "column", flexShrink: 0 },
      el(Text, { dimColor: true }, `  no targets in profile "${state.profile}"`),
    );
  }

  const visible = state.rows.slice(state.windowTop, state.windowTop + state.viewport);
  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    ...visible.map((row, offset) => {
      const selected = state.windowTop + offset === state.cursor;
      const progress = progressLabel(row.targets, state.progress);
      return el(
        Text,
        { key: row.id, wrap: "truncate-end", bold: selected },
        el(Text, { color: "cyan" }, selected ? CURSOR : NO_CURSOR),
        row.text,
        progress === undefined ? null : el(Text, { color: "cyan" }, `  ${progress}`),
      );
    }),
  );
}
