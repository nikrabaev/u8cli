/**
 * The bottom lines: the answer to the last key pressed, the last run's result,
 * and what the keys do here.
 *
 * The hint bar is always drawn — a dashboard whose keys are only discoverable
 * through `?` is a dashboard nobody presses `?` on.
 */
import { Box, Text } from "ink";

import { hintText, summaryText } from "../present.js";
import type { DashboardState, NoticeTone } from "../types.js";
import { el, type ReactElement } from "./element.js";

const NOTICE_COLOR: Record<NoticeTone, string> = {
  info: "cyan",
  warn: "yellow",
  error: "red",
};

export function Footer({ state }: { readonly state: DashboardState }): ReactElement {
  const notice = state.notice;
  const summary = state.summary;
  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    notice === undefined
      ? null
      : el(Text, { color: NOTICE_COLOR[notice.tone], wrap: "truncate-end" }, notice.text),
    summary === undefined
      ? null
      : el(Text, { color: summary.ok ? "green" : "red", wrap: "truncate-end" }, summaryText(summary)),
    el(Text, { dimColor: true, wrap: "truncate-end" }, hintText(state.mode, state.help)),
  );
}
