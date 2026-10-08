/**
 * What one instance is made of: its checkouts, its apps and where they listen,
 * and what it borrows from base.
 *
 * A window into lines the controller rebuilds on every flush, so a service
 * that comes up while this is open turns `stopped` into `running` in place.
 */
import { Box, Text } from "ink";

import type { DashboardState } from "../types.js";
import { el, type ReactElement } from "./element.js";
import { toneLine } from "./tone.js";

export function Detail({ state }: { readonly state: DashboardState }): ReactElement {
  const detail = state.detail;
  if (detail === undefined) {
    return el(Box, { flexDirection: "column", flexShrink: 0 }, el(Text, { dimColor: true }, "no instance"));
  }
  const visible = detail.lines.slice(detail.top, detail.top + Math.max(1, state.viewport));
  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    ...visible.map((line, offset) => toneLine(line, detail.top + offset)),
  );
}
