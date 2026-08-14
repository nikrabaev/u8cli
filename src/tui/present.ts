/**
 * Everything the dashboard draws that is not a row.
 *
 * Pure string functions, deliberately kept out of the components: the banner
 * count and the viewport arithmetic have to agree exactly — a header that draws
 * one more line than the list budgeted for scrolls the terminal and the whole
 * frame smears — and that agreement is far easier to hold as two functions over
 * the same state than as JSX read twice.
 */
import { formatDuration, oneLine, STATE_SYMBOL } from "../cli/format.js";
import type { TargetId } from "../config/types.js";
import type { TaskTargetState } from "../ipc/protocol.js";
import type { DashboardState, LogViewState, Mode, RunSummary } from "./types.js";

/** Plugin failures worth a banner line; the rest are counted, not listed. */
const MAX_PLUGIN_BANNERS = 2;

export interface Banner {
  tone: "error" | "warn";
  text: string;
}

/**
 * The lines between the header and the list: why the rows may be lying.
 *
 * Order is worst-first — a config error means the daemon is running something
 * other than what is on disk (SPEC §8), which explains more than a disabled
 * plugin does.
 */
export function banners(state: DashboardState): Banner[] {
  const out: Banner[] = [];
  if (state.configError !== undefined) {
    out.push({
      tone: "error",
      text: `config error — running the last-good config: ${oneLine(state.configError, 120)}`,
    });
  }
  for (const failure of state.pluginErrors.slice(0, MAX_PLUGIN_BANNERS)) {
    out.push({ tone: "error", text: `plugin "${failure.plugin}" disabled: ${oneLine(failure.error, 100)}` });
  }
  const hidden = state.pluginErrors.length - MAX_PLUGIN_BANNERS;
  if (hidden > 0) out.push({ tone: "error", text: `…and ${hidden} more plugin error(s)` });

  if (state.connection === "reconnecting") {
    out.push({ tone: "warn", text: "daemon unavailable — reconnecting…" });
  } else if (state.connection === "lost") {
    out.push({ tone: "error", text: "lost the daemon and gave up reconnecting — press q to quit" });
  }
  return out;
}

/**
 * `myworkspace · profile full · 2/3 running · daemon 0.1.0`.
 *
 * The last segment is the daemon's *state*, not just its version: a dashboard
 * whose numbers have quietly stopped moving has to say so at a glance, and the
 * version is only interesting while there is one answering.
 */
export function headerText(state: DashboardState): string {
  return [
    state.workspace,
    `profile ${state.profile}`,
    `${state.running}/${state.total} running`,
    state.connection === "connected" ? `daemon ${state.daemonVersion}` : `daemon ${state.connection}`,
  ].join(" · ");
}

/**
 * `rows 3-12/40` — where the window sits, and only while there is a window to
 * sit in. A list that fits says nothing, because then there is nothing to say.
 */
export function rowRangeText(state: DashboardState): string | undefined {
  const total = state.rows.length;
  if (total <= state.viewport) return undefined;
  const last = Math.min(total, state.windowTop + state.viewport);
  return `rows ${state.windowTop + 1}-${last}/${total}`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Footer lines: the hint bar, plus a notice and a run summary when present. */
export function footerLines(state: DashboardState): number {
  return 1 + (state.notice === undefined ? 0 : 1) + (state.summary === undefined ? 0 : 1);
}

/**
 * Rows the list may draw.
 *
 * One line for the header, one per banner, and the footer's — anything left is
 * the list. Never zero: a one-row window still shows where the cursor is.
 *
 * The extra reserved line is not spare: Ink switches to erasing the whole screen
 * (and with it the user's shell scrollback) the moment a frame is as tall as the
 * terminal. Leaving one line unspent keeps it on the incremental path, so
 * quitting the dashboard returns you to your history rather than a blank
 * terminal. See `lastOutputHeight >= stdout.rows` in ink's render loop.
 */
const RESERVED_ROWS = 2;

export function listViewport(terminalRows: number, state: DashboardState): number {
  return Math.max(1, terminalRows - RESERVED_ROWS - banners(state).length - footerLines(state));
}

/** Same, for the log view, which spends two lines on its title and status bar. */
export function logViewport(terminalRows: number, state: DashboardState): number {
  return Math.max(1, terminalRows - RESERVED_ROWS - banners(state).length - 2 - footerLines(state));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * What a row shows while a run touches it: `… running` for a single target, a
 * tally (`2 ok, 1 running`) for an app header row covering several.
 */
export function progressLabel(
  targets: readonly TargetId[],
  progress: Readonly<Record<TargetId, TaskTargetState>>,
): string | undefined {
  const states: TaskTargetState[] = [];
  for (const targetId of targets) {
    const state = progress[targetId];
    if (state !== undefined) states.push(state);
  }
  const only = states[0];
  if (only === undefined) return undefined;
  if (states.length === 1) return `${STATE_SYMBOL[only]} ${only}`;

  const tally = new Map<TaskTargetState, number>();
  for (const state of states) tally.set(state, (tally.get(state) ?? 0) + 1);
  return [...tally].map(([state, count]) => `${count} ${state}`).join(", ");
}

/** `test: 2 ok, 1 failed in 1.4s` — the compact result line under the list. */
export function summaryText(summary: RunSummary): string {
  const counts = summary.counts.map(({ state, count }) => `${count} ${state}`).join(", ");
  return `${summary.command}: ${counts || "nothing to do"} in ${formatDuration(summary.durationMs)}`;
}

// ---------------------------------------------------------------------------
// Log view
// ---------------------------------------------------------------------------

/** `logs platform.web · following · 1204 lines` (`paused` while scrolled back). */
export function logTitle(view: LogViewState, total: number): string {
  const parts = [`logs ${view.title}`];
  parts.push(view.follow ? "following" : "paused");
  parts.push(view.loading ? "loading…" : `${total} line${total === 1 ? "" : "s"}`);
  if (view.dropped > 0) parts.push(`${view.dropped} dropped`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The one-line key hint bar.
 *
 * Kept inside 80 columns on purpose: the bar is truncated to the terminal's
 * width, and a hint that ends in `…` is worse than a shorter one. What does not
 * fit — chiefly that quitting costs nothing — is in the `?` overlay and in
 * {@link FAREWELL}.
 */
export function hintText(mode: Mode, help: boolean): string {
  if (help) return "? or esc  close help";
  switch (mode) {
    case "logs":
      return "↑↓ scroll  pgup/pgdn page  g/G top/bottom  esc back";
    case "palette":
      return "type to filter  ↵ run  tab scope  esc close";
    case "profiles":
      return "↑↓ move  ↵ use  esc close";
    case "list":
      return "↑↓ move  ↵ logs  s/x/r target  S/X/R all  : palette  P profile  ? help  q quit";
  }
}

/** The narrowest terminal a hint bar has to survive without an ellipsis. */
export const HINT_WIDTH_BUDGET = 80;

/**
 * The line left on the terminal after the dashboard closes.
 *
 * "Quit" in a process supervisor reads like "stop everything" and here it is the
 * opposite (SPEC §9.1), so the last thing on screen says so — and says how to
 * get back to the stack it left running.
 */
export const FAREWELL =
  "dashboard closed — the daemon and its services keep running (u8 status · u8 daemon stop)";

export interface HelpEntry {
  keys: string;
  what: string;
}

/** The `?` overlay. Same bindings as {@link hintText}, with room to explain. */
export const HELP: readonly HelpEntry[] = [
  { keys: "↑ ↓ / k j", what: "move the cursor" },
  { keys: "pgup pgdn", what: "page through the list" },
  { keys: "g / G", what: "first / last row" },
  { keys: "s x r", what: "start / stop / restart the selection" },
  { keys: "S X R", what: "start / stop / restart the whole profile" },
  { keys: "↵", what: "open the log view (esc returns)" },
  { keys: ": or p", what: "command palette — run any command" },
  { keys: "P", what: "switch profile" },
  { keys: "?", what: "toggle this help" },
  { keys: "q", what: "quit the dashboard; the daemon and its services keep running" },
];
