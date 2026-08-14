/**
 * The top of the screen: what workspace this is, and everything that is wrong
 * with it.
 *
 * The banner lines are the reason this is not one `<Text>` — a config that
 * failed to reload (SPEC §8) or a plugin that refused to load explains why the
 * rows below look wrong, and burying that in a notice that times out would
 * leave the dashboard quietly lying.
 */
import { Box, Text } from "ink";

import { banners, headerText, rowRangeText } from "../present.js";
import type { DashboardState } from "../types.js";
import { el, type ReactElement } from "./element.js";

export function Header({ state }: { readonly state: DashboardState }): ReactElement {
  const range = rowRangeText(state);
  return el(
    Box,
    { flexDirection: "column" },
    el(
      Text,
      { wrap: "truncate-end" },
      el(Text, { bold: true, color: "cyan" }, "u8"),
      el(Text, { dimColor: true }, ` ${headerText(state)}`),
      range === undefined ? null : el(Text, { dimColor: true }, ` · ${range}`),
    ),
    ...banners(state).map((banner, index) =>
      el(
        Text,
        {
          // Banners are positional and short-lived; their tone and slot identify them.
          key: `${banner.tone}:${index}`,
          color: banner.tone === "error" ? "red" : "yellow",
          wrap: "truncate-end",
        },
        banner.text,
      ),
    ),
  );
}
