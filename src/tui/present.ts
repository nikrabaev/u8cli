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
import { displayWidth } from "../template/index.js";
import type { DashboardState, LogViewState, Mode, ReportState, RunSummary, ToneLine } from "./types.js";

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
  // Last: nothing is wrong, but what is on screen is not what the directory
  // suggests — the same thing `u8 status` says there, with the key instead of
  // the command.
  if (state.worktree !== undefined) {
    out.push({
      tone: "warn",
      text: "this worktree has no instance of its own, so this is the base instance — i then w creates one for it",
    });
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
    // Only once there is more than base: the count is across all of them then,
    // and saying so is what stops it reading as the profile's own.
    ...(state.instances > 1 ? [`${state.instances} instances`] : []),
    // The count that follows is the focused instance's alone, and says so.
    ...(state.focus === undefined ? [] : [`focus ${state.focus}`]),
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

/** Instance actions worth a footer line each; the rest are counted. */
const MAX_ACTIVITY_LINES = 2;

/**
 * The instance actions still in flight, as footer lines.
 *
 * A create spends its first seconds making worktrees, before there is a row to
 * draw progress on, and an `up` is two runs back to back — this is what says
 * the dashboard has not forgotten either. Bounded like the plugin banners.
 */
export function activityLines(state: DashboardState): string[] {
  const all = state.activity;
  if (all.length <= MAX_ACTIVITY_LINES) return all.map((line) => `… ${line}`);
  const shown = all.slice(0, MAX_ACTIVITY_LINES - 1).map((line) => `… ${line}`);
  return [...shown, `… and ${all.length - shown.length} more instance actions in flight`];
}

/** Footer lines: the hint bar, plus the actions in flight, a notice and a run summary when present. */
export function footerLines(state: DashboardState): number {
  return (
    1 + activityLines(state).length + (state.notice === undefined ? 0 : 1) + (state.summary === undefined ? 0 : 1)
  );
}

/**
 * How tall the frame itself is: one line short of the terminal.
 *
 * Not spare, and not about scrollback any more — the dashboard runs on the
 * alternate screen, which has none to lose. What the held-back line buys is
 * Ink's *incremental* render path: a frame as tall as the terminal flips Ink to
 * writing `2J 3J` and repainting everything on every frame, with no
 * output-unchanged guard, which flickers on any terminal that ignores
 * synchronized-update mode and is handled inconsistently by multiplexers.
 * See `lastOutputHeight >= stdout.rows` in ink's render loop.
 *
 * The screen still looks full: Ink appends a newline after the frame, so the
 * cursor parks on the last row and nothing else is drawn there.
 */
export function frameRows(terminalRows: number): number {
  return Math.max(1, terminalRows - 1);
}

/** The header line, which the frame always spends before anything else. */
const HEADER_ROWS = 1;

/**
 * Rows the list may draw.
 *
 * One line for the header, one per banner, and the footer's — anything left is
 * the list. Never zero: a one-row window still shows where the cursor is.
 */
export function listViewport(terminalRows: number, state: DashboardState): number {
  return Math.max(1, frameRows(terminalRows) - HEADER_ROWS - banners(state).length - footerLines(state));
}

/** Same, for the log view, which spends two lines on its title and status bar. */
export function logViewport(terminalRows: number, state: DashboardState): number {
  return Math.max(1, listViewport(terminalRows, state) - 2);
}

// ---------------------------------------------------------------------------
// Panels of text
// ---------------------------------------------------------------------------

/**
 * Wraps one line to `width` columns at word boundaries, carrying its indent.
 *
 * A refusal from the daemon is a sentence of two hundred characters and has to
 * be read whole; truncating it the way a row is truncated would cut off the
 * part that says what to do. Continuation lines hang two columns in, so a
 * wrapped sentence still reads as one item.
 */
export function wrapText(text: string, width: number): string[] {
  // A message can already be several lines — git's own failures are two — and
  // each is wrapped on its own: handed to the terminal as one, a line break in
  // the middle draws a row nobody budgeted for and scrolling stops short of it.
  const physical = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  return physical.length === 1 ? wrapLine(physical[0] ?? "", width) : physical.flatMap((line) => wrapLine(line, width));
}

function wrapLine(text: string, width: number): string[] {
  const room = Math.max(8, width);
  if (displayWidth(text) <= room) return [text];
  const indent = /^ */.exec(text)?.[0] ?? "";
  const hang = `${indent}  `;
  const out: string[] = [];
  let line = indent;
  let empty = true;
  for (const word of text.slice(indent.length).split(" ")) {
    let rest = word;
    for (;;) {
      const candidate = empty ? `${line}${rest}` : `${line} ${rest}`;
      if (displayWidth(candidate) <= room) {
        line = candidate;
        empty = false;
        break;
      }
      if (!empty) {
        out.push(line);
        line = hang;
        empty = true;
        continue;
      }
      // A single word wider than the line — a path, usually: cut it where it has to be.
      const fit = Math.max(1, room - displayWidth(line));
      out.push(`${line}${rest.slice(0, fit)}`);
      rest = rest.slice(fit);
      line = hang;
      if (rest.length === 0) break;
    }
  }
  if (!empty) out.push(line);
  return out;
}

/** {@link wrapText} over toned lines; every piece keeps its line's tone. */
export function wrapLines(lines: readonly ToneLine[], width: number): ToneLine[] {
  return lines.flatMap((line) => wrapText(line.text, width).map((text) => ({ text, tone: line.tone })));
}

/**
 * Lines of a report the body has room for: one goes to its title, and one to
 * the follow-ups when it offers any.
 */
export function reportWindow(viewport: number, report: Pick<ReportState, "actions">): number {
  return Math.max(1, viewport - 1 - (report.actions.length > 0 ? 1 : 0));
}

/** `✓ feat-x · add api` — and how many more results are queued behind it. */
export function reportTitle(report: ReportState): string {
  const waiting = report.waiting > 0 ? `  (${report.waiting} more result${report.waiting === 1 ? "" : "s"} after this)` : "";
  return `${report.ok ? STATE_SYMBOL.ok : STATE_SYMBOL.failed} ${report.title}${waiting}`;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * What a row shows while a run touches it: `… running` for a single target, a
 * tally (`2 ok, 1 running`) for a repo header row covering several.
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
    case "instance":
      return "↑↓ move  ↵ or its letter runs it  esc close";
    case "detail":
      return "↑↓ scroll  pgup/pgdn page  g/G top/bottom  i actions  esc back";
    case "form":
      return "↑↓ field  type to edit  space toggle  ←→ choose  ↵ submit  esc cancel";
    case "confirm":
      return "answer as asked above  esc cancel";
    case "report":
      return "↑↓ scroll  pgup/pgdn page  ↵ or esc close";
    case "list":
      // The arrows gave their place to `i`: of everything on this bar they are
      // the one binding nobody has to be told.
      return "↵ logs  s/x/r row  S/X/R all  i instance  : palette  P profile  ? help  q quit";
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
  { keys: "S X R", what: "start / stop / restart the whole profile — or the instance the cursor is in" },
  { keys: "↵", what: "open the log view (esc returns)" },
  { keys: ": or p", what: "command palette — run any command" },
  { keys: "P", what: "switch profile" },
  { keys: "i", what: "instance menu — details, up, init, add or remove apps, destroy, new" },
  { keys: "tab ⇧tab", what: "next / previous instance section" },
  { keys: "← → / h l", what: "collapse / expand the section under the cursor" },
  { keys: "z", what: "collapse every section, or expand them all" },
  { keys: "f", what: "focus on the instance under the cursor; again shows them all" },
  { keys: "?", what: "toggle this help" },
  { keys: "q", what: "quit the dashboard; the daemon and its services keep running" },
];
