/**
 * The full-screen log view.
 *
 * It draws a window into the controller's bounded scrollback and nothing else —
 * no subscription, no buffering, no timers. That is what keeps a service
 * printing thousands of lines a second cheap here: the controller coalesces the
 * flood into one frame and this component re-renders at most that often.
 */
import { Box, Text } from "ink";

import { logWindow } from "../logs.js";
import { logTitle } from "../present.js";
import type { DashboardState, LogViewState } from "../types.js";
import { el, type ReactElement } from "./element.js";

export function LogView({ state }: { readonly state: DashboardState }): ReactElement {
  const view = state.logs;
  if (view === undefined) {
    return el(Box, { flexDirection: "column" }, el(Text, { dimColor: true }, "no log view"));
  }

  const window = logWindow(view, state.logViewport);
  return el(
    Box,
    { flexDirection: "column" },
    el(Text, { bold: true, wrap: "truncate-end" }, logTitle(view, window.total)),
    ...window.lines.map((line) =>
      el(
        Text,
        {
          key: line.seq,
          wrap: "truncate-end",
          color: line.stream === "stderr" ? "red" : undefined,
          dimColor: line.stream === "u8",
        },
        // Only a view merging several targets needs to say which one spoke.
        view.prefix ? `${line.targetId} | ` : "",
        line.text,
      ),
    ),
    el(
      Text,
      { color: view.follow ? "green" : "yellow", wrap: "truncate-end" },
      statusText(view, window.total),
    ),
  );
}

/**
 * The line that says whether new output will appear.
 *
 * A paused view looks exactly like a dead service, so pausing has to announce
 * itself *and* say how to undo it.
 */
function statusText(view: LogViewState, total: number): string {
  if (view.loading) return "loading…";
  if (view.follow) return total === 0 ? "following — waiting for output" : "following";
  return "paused — G or End resumes following";
}
