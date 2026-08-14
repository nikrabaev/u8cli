/**
 * The command palette: every command the daemon knows about, filtered by typing.
 *
 * Each row says how many of the command's targets are inside the current scope,
 * because "run `test` on this selection" and "run `test` on the profile" are
 * different amounts of work and the palette is the last place to notice.
 */
import { Box, Text } from "ink";

import { windowTopFor } from "../scroll.js";
import type { DashboardState, PaletteItem } from "../types.js";
import { el, type ReactElement } from "./element.js";

/** Query line + scope line; the rest of the body is the item list. */
const CHROME_LINES = 2;

export function Palette({ state }: { readonly state: DashboardState }): ReactElement {
  const palette = state.palette;
  if (palette === undefined) {
    return el(Box, { flexDirection: "column", flexShrink: 0 }, el(Text, { dimColor: true }, "no palette"));
  }

  const height = Math.max(1, state.viewport - CHROME_LINES);
  const top = windowTopFor(palette.index, palette.items.length, height, 0);
  const visible = palette.items.slice(top, top + height);
  const width = Math.max(...palette.items.map((item) => item.name.length), 0);
  const otherScope = palette.scope === "profile" ? "selection" : "whole profile";

  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    el(
      Text,
      { wrap: "truncate-end" },
      el(Text, { color: "cyan" }, "> "),
      palette.query,
      el(Text, { dimColor: true }, "▌"),
    ),
    el(
      Text,
      { dimColor: true, wrap: "truncate-end" },
      `  on ${palette.scopeLabel} · tab runs it on the ${otherScope}`,
    ),
    ...(visible.length === 0
      ? [el(Text, { key: "empty", dimColor: true }, `  no command matches "${palette.query}"`)]
      : visible.map((item, offset) => itemRow(item, width, top + offset === palette.index))),
  );
}

function itemRow(item: PaletteItem, width: number, selected: boolean): ReactElement {
  const applies = `${item.matched.length}/${item.appliesTo.length} target${item.appliesTo.length === 1 ? "" : "s"}`;
  return el(
    Text,
    { key: item.name, wrap: "truncate-end", bold: selected },
    el(Text, { color: "cyan" }, selected ? "❯ " : "  "),
    item.name.padEnd(width),
    el(Text, { dimColor: true }, `  ${item.source}/${item.kind}`),
    // Zero matched targets in the current scope means enter would do nothing.
    el(Text, { color: item.matched.length === 0 ? "yellow" : "green" }, `  ${applies}`),
    item.description === undefined ? null : el(Text, { dimColor: true }, ` — ${item.description}`),
  );
}
