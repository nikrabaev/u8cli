/**
 * TUI layer entry point.
 *
 * `runDashboard` is what the CLI reaches for; everything else is exported for
 * tests and for anything that wants the dashboard's state without a terminal —
 * the controller is a complete headless implementation of the screen.
 */
export { runDashboard, type DashboardOptions } from "./run.js";

export {
  createController,
  describeTargets,
  DEFAULT_BACKFILL_LINES,
  DEFAULT_FRAME_MS,
  DEFAULT_SCROLLBACK,
  NOTICE_TTL_MS,
  type ActionScope,
  type Cancel,
  type ControllerOptions,
  type DashboardController,
  type Scheduler,
} from "./controller.js";

export { dashboardClient } from "./types.js";
export type {
  ConnectionState,
  DashboardClient,
  DashboardState,
  LogEntry,
  LogViewState,
  Mode,
  Notice,
  NoticeTone,
  PaletteItem,
  PaletteScope,
  PaletteState,
  PluginFailure,
  ProfileMenuState,
  ProfileOption,
  RunSummary,
  TuiKey,
} from "./types.js";

export { buildRows, indicatorKey, type DashboardRow, type RowInput } from "./rows.js";
export { appendLogLines, logWindow, type LogWindow } from "./logs.js";
export { dispatchKey } from "./keymap.js";
export { clamp, windowTopFor } from "./scroll.js";
export {
  banners,
  footerLines,
  headerText,
  hintText,
  listViewport,
  logTitle,
  logViewport,
  progressLabel,
  rowRangeText,
  summaryText,
  FAREWELL,
  HELP,
  HINT_WIDTH_BUDGET,
  type Banner,
  type HelpEntry,
} from "./present.js";

export { App, type AppProps } from "./components/App.js";
