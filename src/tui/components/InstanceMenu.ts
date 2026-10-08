/**
 * The instance menu (`i`): what can be done with the instance under the cursor.
 *
 * One list rather than a key per action, for two reasons. The list key bar has
 * no room for seven more bindings; and what is *absent* is information — base's
 * menu has no add, remove or destroy, which says more plainly than any refusal
 * that base is not edited from here.
 */
import { Box, Text } from "ink";

import { windowTopFor } from "../scroll.js";
import type { DashboardState, InstanceMenuItem } from "../types.js";
import { el, type ReactElement } from "./element.js";

/** The title line above the entries. */
const CHROME_LINES = 1;

export function InstanceMenu({ state }: { readonly state: DashboardState }): ReactElement {
  const menu = state.instanceMenu;
  if (menu === undefined) {
    return el(Box, { flexDirection: "column", flexShrink: 0 }, el(Text, { dimColor: true }, "no instance menu"));
  }

  const height = Math.max(1, state.viewport - CHROME_LINES);
  const top = windowTopFor(menu.index, menu.items.length, height, 0);
  const visible = menu.items.slice(top, top + height);
  const width = Math.max(...menu.items.map((item) => item.label.length), 0);

  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    el(
      Text,
      { wrap: "truncate-end" },
      el(Text, { bold: true }, `instance ${menu.instance}`),
      menu.summary.length === 0 ? null : el(Text, { dimColor: true }, ` · ${menu.summary}`),
    ),
    ...visible.map((item, offset) => itemRow(item, width, top + offset === menu.index)),
  );
}

function itemRow(item: InstanceMenuItem, width: number, selected: boolean): ReactElement {
  const off = item.disabled !== undefined;
  return el(
    Text,
    { key: item.id, wrap: "truncate-end", bold: selected && !off, dimColor: off },
    el(Text, { color: "cyan" }, selected ? "❯ " : "  "),
    el(Text, { color: off ? undefined : "cyan" }, `${item.key}  `),
    item.label.padEnd(width),
    // A greyed entry says why, where the others say what they do.
    el(Text, { dimColor: true }, `  ${off ? `— ${item.disabled}` : item.hint}`),
  );
}
