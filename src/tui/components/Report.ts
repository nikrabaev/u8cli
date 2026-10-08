/**
 * How an instance action ended.
 *
 * It takes the whole body rather than one line of the footer because the part
 * that matters does not fit in one: a refusal is a sentence that ends in what
 * to do about it, and a failed init step is explained by the last lines it
 * printed. It stays until it is dismissed — an action that took a minute is
 * exactly the one whose result arrives while nobody is looking.
 */
import { Box, Text } from "ink";

import { reportTitle, reportWindow } from "../present.js";
import type { DashboardState } from "../types.js";
import { el, type ReactElement } from "./element.js";
import { toneLine } from "./tone.js";

export function Report({ state }: { readonly state: DashboardState }): ReactElement {
  const report = state.report;
  if (report === undefined) {
    return el(Box, { flexDirection: "column", flexShrink: 0 }, el(Text, { dimColor: true }, "no result"));
  }
  const height = reportWindow(state.viewport, report);
  const visible = report.lines.slice(report.top, report.top + height);
  const below = report.lines.length - (report.top + visible.length);

  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    el(
      Text,
      { bold: true, color: report.ok ? "green" : "red", wrap: "truncate-end" },
      reportTitle(report),
      below > 0 ? el(Text, { dimColor: true, bold: false }, `  ↓ ${below} more line${below === 1 ? "" : "s"}`) : null,
    ),
    ...visible.map((line, offset) => toneLine(line, report.top + offset)),
    report.actions.length === 0
      ? null
      : el(
          Text,
          { wrap: "truncate-end" },
          ...report.actions.flatMap((action, index) => [
            el(Text, { key: `key:${action.key}`, color: "cyan", bold: true }, `${index === 0 ? "" : "   "}${action.key} `),
            el(Text, { key: `label:${action.key}` }, action.label),
          ]),
        ),
  );
}
