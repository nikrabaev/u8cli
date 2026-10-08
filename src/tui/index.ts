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
  ConfirmState,
  ConnectionState,
  DashboardClient,
  DashboardState,
  DetailState,
  FormField,
  FormState,
  InstanceActionId,
  InstanceMenuItem,
  InstanceMenuState,
  LineTone,
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
  ReportAction,
  ReportState,
  RunSummary,
  ToneLine,
  TuiKey,
  UnregisteredWorktree,
} from "./types.js";

export {
  buildRows,
  indicatorKey,
  sectionRowId,
  type DashboardRow,
  type RowInput,
  type RowSection,
  type SectionFlag,
} from "./rows.js";
export {
  addableApps,
  destroyLines,
  detailLines,
  externalDependencies,
  instanceApps,
  instanceChanges,
  keptCheckouts,
  sectionFlags,
  type SectionFacts,
} from "./instances.js";
export { createOperations, type FollowUp, type Operations, type Refusal, type Report } from "./operations.js";
export { appendLogLines, logWindow, type LogWindow } from "./logs.js";
export { dispatchKey } from "./keymap.js";
export { clamp, windowTopFor } from "./scroll.js";
export {
  activityLines,
  banners,
  footerLines,
  headerText,
  hintText,
  frameRows,
  listViewport,
  logTitle,
  logViewport,
  progressLabel,
  reportTitle,
  reportWindow,
  rowRangeText,
  summaryText,
  wrapLines,
  wrapText,
  FAREWELL,
  HELP,
  HINT_WIDTH_BUDGET,
  type Banner,
  type HelpEntry,
} from "./present.js";

export { App, type AppProps } from "./components/App.js";
