/**
 * The dashboard, minus the pixels.
 *
 * Everything with a lifetime lives here — the attach subscriptions, the log
 * backfill, the in-flight runs, the scroll positions — and the Ink components
 * are a pure function of the state it publishes. That is what lets the
 * interesting behaviour (a daemon that goes away, a service that floods stdout,
 * a command run against a selection) be tested against a fake client instead of
 * a terminal.
 *
 * Three rules hold throughout:
 *
 *  - **Push-driven updates are throttled.** A dev server emits hundreds of lines
 *    a second and every one of them is a state change; re-rendering per line
 *    melts the terminal. Notifications mark the model dirty and one flush per
 *    frame publishes the result, while a keypress flushes immediately so input
 *    never feels laggy.
 *  - **Nothing is unbounded.** Scrollback is capped and evicted from the front;
 *    finished runs are dropped from the progress map; results waiting to be
 *    read are a short queue that loses its oldest.
 *  - **A dropped daemon is a banner, not a crash.** `attach` re-attaches (and
 *    respawns) underneath; the controller only tracks which of the three
 *    connection states to draw and re-applies whatever snapshot comes back.
 *
 * Instances add a fourth, which is the reason they are in a dashboard at all:
 *
 *  - **An action is about the instance it was asked on, and asks before it
 *    destroys.** The instance menu captures the instance under the cursor when
 *    it opens, and everything that follows — a form, a question, the request —
 *    names that instance, wherever the cursor has drifted since. Base's menu has
 *    no entry that edits or destroys it. What the daemon refuses is shown in its
 *    words; what removes a worktree is typed, not pressed.
 */
import { nameForWorktree } from "../cli/instance-report.js";
import { BASE_INSTANCE, splitQualified, type TargetId } from "../config/types.js";
import type {
  IndicatorValue,
  InstanceRemoveParams,
  LogLine,
  ServiceState,
  Snapshot,
  SnapshotProfile,
  TaskResult,
  TaskTargetState,
} from "../ipc/protocol.js";
import { errorMessage } from "../util/errors.js";
import {
  addableApps,
  destroyLines,
  detailLines,
  findInstance,
  instanceApps,
  instanceChanges,
  keptCheckouts,
  sectionFacts,
  sectionFlags,
  sectionSummary,
  worktreeCovered,
  type IndicatorReader,
} from "./instances.js";
import { dispatchKey } from "./keymap.js";
import { appendLogLines, logViewBottom, logViewTop, scrollLogView } from "./logs.js";
import { createOperations, type Refusal, type Report, type ReportFollowUp } from "./operations.js";
import { reportWindow, wrapLines } from "./present.js";
import { buildRows, indicatorKey, sectionRowId, type DashboardRow, type RowSection } from "./rows.js";
import { clamp, windowTopFor } from "./scroll.js";
import type {
  ConfirmState,
  ConnectionState,
  DashboardClient,
  DashboardState,
  DetailState,
  FormField,
  FormState,
  InstanceMenuItem,
  InstanceMenuState,
  LogViewState,
  Mode,
  Notice,
  NoticeTone,
  PaletteItem,
  PaletteState,
  ProfileOption,
  ReportState,
  RunSummary,
  ToneLine,
  TuiKey,
  UnregisteredWorktree,
  Unsubscribe,
} from "./types.js";

/** ~12fps. Fast enough to feel live, slow enough that a log flood is free. */
export const DEFAULT_FRAME_MS = 80;

/** Lines of scrollback kept per log view (SPEC risk list: windowed scrollback). */
export const DEFAULT_SCROLLBACK = 2_000;

/** Backfill requested when a log view opens. */
export const DEFAULT_BACKFILL_LINES = 500;

/** How long a notice stays on screen before it stops being news. */
export const NOTICE_TTL_MS = 6_000;

/** Rows assumed before the component reports the real terminal height. */
const INITIAL_VIEWPORT = 10;

/** Columns assumed before the component reports the real terminal width. */
const INITIAL_COLUMNS = 80;

/** Results kept waiting to be read; the oldest goes first when one more would not fit. */
const MAX_REPORTS = 20;

/** Changes one reload notice spells out before it starts counting. */
const MAX_CHANGES_IN_NOTICE = 2;

/** "As far down as it goes": scroll positions are clamped when the state is built. */
const BOTTOM = Number.MAX_SAFE_INTEGER;

export type Cancel = () => void;

/** Injectable so tests can drive frames without timers. Returns a canceller. */
export type Scheduler = (fn: () => void, ms: number) => Cancel;

/** Whether a key acts on the cursor's row or on the whole profile. */
export type ActionScope = "selection" | "profile";

const defaultScheduler: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  // A pending frame must never be the reason the process stays alive.
  timer.unref();
  return () => clearTimeout(timer);
};

export interface ControllerOptions {
  client: DashboardClient;
  /**
   * The instance the dashboard was opened for; the cursor starts on its
   * section. Everything is still listed — the dashboard is the one place every
   * instance is visible at once — this only decides where you land.
   */
  instance?: string;
  /**
   * Root of the git worktree the dashboard was opened in, when it is a
   * worktree of this workspace that no instance covers. The dashboard says so
   * and offers to make one from it, as `u8 up` would.
   */
  worktree?: string;
  /** The TUI owns a terminal, so this defaults to true. */
  color?: boolean;
  /** Minimum gap between push-driven re-renders. */
  frameMs?: number;
  scrollback?: number;
  backfill?: number;
  scheduler?: Scheduler;
  /** Epoch ms. Injectable so "created 2h ago" can be asserted. */
  now?: () => number;
}

/**
 * Actions never reject: a failed RPC becomes a notice on screen, because a
 * rejected promise from a keypress has nowhere to go in a rendered app.
 */
export interface DashboardController {
  getState(): DashboardState;
  subscribe(cb: (state: DashboardState) => void): Unsubscribe;
  /** Ink's `useInput` argument, straight through. Ignores keys the mode has no use for. */
  handleKey(input: string, key: TuiKey): void;

  /** Rows the list may draw; set by the component from the terminal height. */
  setViewport(height: number): void;
  setLogViewport(height: number): void;
  /** The terminal's width: what a refusal or a log tail is wrapped to. */
  setColumns(width: number): void;

  moveCursor(delta: number): void;
  setCursor(index: number): void;
  /** To the next (`1`) or previous (`-1`) section heading. */
  jumpSection(delta: number): void;
  /** Folds the section under the cursor into its heading, and lands on it. */
  collapseSection(): void;
  expandSection(): void;
  /** Collapses every section, or expands them all when they already are. */
  toggleAllSections(): void;
  /** Narrows the list to the instance under the cursor; again shows them all. */
  toggleFocus(): void;

  start(scope: ActionScope): Promise<void>;
  stop(scope: ActionScope): Promise<void>;
  restart(scope: ActionScope): Promise<void>;

  openLogs(): Promise<void>;
  closeLogs(): Promise<void>;
  scrollLogs(delta: number): void;
  logsTop(): void;
  logsBottom(): void;

  openPalette(): void;
  closePalette(): void;
  paletteType(text: string): void;
  paletteBackspace(): void;
  paletteMove(delta: number): void;
  paletteToggleScope(): void;
  paletteRun(): Promise<void>;

  openProfiles(): void;
  closeProfiles(): void;
  profilesMove(delta: number): void;
  profilesSelect(): Promise<void>;

  /** The things to do with the instance under the cursor. */
  openInstanceMenu(): void;
  closeInstanceMenu(): void;
  instanceMenuMove(delta: number): void;
  /** Runs the highlighted entry, or the one `key` is the letter of. */
  instanceMenuRun(key?: string): Promise<void>;

  closeDetail(): void;
  detailScroll(delta: number): void;
  detailTop(): void;
  detailBottom(): void;
  /** The menu for the instance the detail view is about. */
  detailActions(): void;

  formMove(delta: number): void;
  formType(text: string): void;
  formBackspace(): void;
  /** Space: ticks a checkbox, or moves a choice on by one. */
  formToggle(): void;
  formCycle(delta: number): void;
  formSubmit(): Promise<void>;
  closeForm(): void;

  confirmType(text: string): void;
  confirmBackspace(): void;
  /** Enter: goes ahead only when what was asked for has been typed. */
  confirmAccept(): void;
  /** `y`: goes ahead on a question that asks for no more than that. */
  confirmYes(): void;
  closeConfirm(): void;

  reportScroll(delta: number): void;
  reportTop(): void;
  reportBottom(): void;
  /** Runs the follow-up a report offers under `key`. */
  reportAct(key: string): Promise<void>;
  dismissReport(): void;

  toggleHelp(): void;
  dismissNotice(): void;
  quit(): void;
  /** Drops every subscription and timer; safe to call twice. */
  dispose(): Promise<void>;
}

export function createController(opts: ControllerOptions): DashboardController {
  const client = opts.client;
  const color = opts.color ?? true;
  const frameMs = Math.max(0, opts.frameMs ?? DEFAULT_FRAME_MS);
  const scrollback = Math.max(1, opts.scrollback ?? DEFAULT_SCROLLBACK);
  const backfillLines = Math.max(0, opts.backfill ?? DEFAULT_BACKFILL_LINES);
  const schedule = opts.scheduler ?? defaultScheduler;
  const now = opts.now ?? Date.now;

  // --- model ---------------------------------------------------------------

  let snapshot: Snapshot = client.snapshot();
  const indicators = new Map<string, IndicatorValue>();
  const services = new Map<TargetId, ServiceState>();
  const pluginErrors = new Map<string, string>();
  /** In-flight runs, so progress from two overlapping runs cannot clobber one another. */
  const runs = new Map<string, { command: string; targets: Map<TargetId, TaskTargetState> }>();
  const pendingLines: LogLine[] = [];
  const listeners = new Set<(state: DashboardState) => void>();
  const disposers: Unsubscribe[] = [];

  let mode: Mode = "list";
  let help = false;
  let connection: ConnectionState = "connected";
  let configError: string | undefined;
  let notice: Notice | undefined;
  let summary: RunSummary | undefined;
  let logs: LogViewState | undefined;
  let palette: PaletteState | undefined;
  /**
   * What the palette acts on, fixed when it opens. Its scope line is a promise
   * about where Enter will run a command, and the cursor can be moved from
   * under an open palette — by an instance that goes away, or one that arrives.
   */
  let paletteOn: { instance: string; targets: TargetId[] } | undefined;
  let profileMenu: { index: number } | undefined;

  /** Sections drawn as their heading alone, by instance. */
  const collapsed = new Set<string>();
  /** Set by "collapse all": an instance that appears later arrives collapsed too. */
  let collapseNew = false;
  /** The one instance the list is narrowed to. */
  let focus: string | undefined;
  let menu: InstanceMenuState | undefined;
  /** Of the list's selection when the menu opened: the apps `remove` starts from. */
  let menuSelection: TargetId[] = [];
  let detail: { instance: string; top: number } | undefined;
  let form: OpenForm | undefined;
  let confirm: OpenConfirm | undefined;
  /** Results not read yet; the first is the one on screen in `report` mode. */
  const reports: Report[] = [];
  let reportTop = 0;
  /** The last result read, so a stray key that closed it has not lost it. */
  let lastReport: Report | undefined;

  let rows: DashboardRow[] = [];
  let cursor = 0;
  /** Sticky selection across rebuilds: the row id, not its index. */
  let selectedId: string | undefined =
    opts.instance === undefined || opts.instance === BASE_INSTANCE ? undefined : sectionRowId(opts.instance);
  /** Where the cursor was, for the rebuild in which its row is gone. */
  let anchor: { instance: string; section: number; offset: number } | undefined;
  /** A row to move to as soon as it exists: the heading of an instance just asked for. */
  let landOn: string | undefined;
  let viewport = INITIAL_VIEWPORT;
  let logViewport = INITIAL_VIEWPORT;
  let columns = INITIAL_COLUMNS;
  let windowTop = 0;

  let seq = 0;
  /** Bumped on every open/close so a slow backfill cannot land in a new view. */
  let generation = 0;
  let rowsDirty = true;
  let exited = false;
  let disposed = false;
  let frame: Cancel | undefined;
  let noticeTimer: Cancel | undefined;
  let state: DashboardState;

  // --- derived -------------------------------------------------------------

  const activeProfile = (): SnapshotProfile =>
    snapshot.profiles.find((p) => p.name === snapshot.activeProfile) ?? {
      name: snapshot.activeProfile,
      isDefault: false,
      appIds: [],
    };

  const currentRow = (): DashboardRow | undefined => rows[cursor];

  const selectionTargets = (): TargetId[] => currentRow()?.targets ?? [];

  const scopeTargets = (scope: ActionScope): TargetId[] | undefined =>
    scope === "profile" ? undefined : [...selectionTargets()];

  /**
   * The instance a key acts in: the one the cursor is on. "The whole profile"
   * said from inside an instance's section means that whole instance — never
   * base, and never somebody else's copy.
   */
  const currentInstance = (): string => currentRow()?.instance ?? BASE_INSTANCE;

  /** `profile full` in base, `instance feat-x` anywhere else. */
  const scopeName = (instance: string = currentInstance()): string =>
    instance === BASE_INSTANCE ? `profile ${activeProfile().name}` : `instance ${instance}`;

  /** Every app "the whole profile" covers in `instance` — where the cursor is, unless said. */
  const scopeAppIds = (instance: string = currentInstance()): TargetId[] => {
    if (instance === BASE_INSTANCE) return activeProfile().appIds;
    return snapshot.instances.find((i) => i.name === instance)?.appIds ?? [];
  };

  /**
   * The snapshot with service states as live as the push stream. Everything
   * that asks "is it running, is it stale" reads this, never `snapshot.services`,
   * which is only as fresh as the last reload.
   */
  const liveSnapshot = (): Snapshot => ({ ...snapshot, services: [...services.values()] });

  const readIndicator: IndicatorReader = (scope, owner, ns, name) =>
    indicators.get(`${scope} ${owner} ${ns} ${name}`)?.value;

  /** Whether the list is sectioned at all: only once there is more than base. */
  const headed = (): boolean => snapshot.instances.length > 1;

  /** The command of a run in flight, by the instance whose apps it touches. */
  const busyInstances = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const run of runs.values()) {
      for (const [targetId, targetState] of run.targets) {
        if (targetState !== "pending" && targetState !== "running") continue;
        const { instance } = splitQualified(targetId);
        if (!out.has(instance)) out.set(instance, run.command);
      }
    }
    return out;
  };

  /** Base's profile, then every other instance: the blocks the list is made of. */
  const sections = (): RowSection[] => {
    const view = liveSnapshot();
    const busy = busyInstances();
    const running = (ids: readonly TargetId[]): number =>
      ids.filter((id) => services.get(id)?.status === "running").length;
    const profile = activeProfile();
    const base = findInstance(snapshot, BASE_INSTANCE);
    const out: RowSection[] = [
      {
        instance: BASE_INSTANCE,
        appIds: profile.appIds,
        running: running(profile.appIds),
        note: `profile ${profile.name}`,
        flags: base === undefined ? [] : sectionFlags(sectionFacts(view, base, profile.appIds, busy.get(BASE_INSTANCE))),
        collapsed: collapsed.has(BASE_INSTANCE),
      },
    ];
    for (const instance of snapshot.instances) {
      if (instance.isBase) continue;
      out.push({
        instance: instance.name,
        appIds: instance.appIds,
        running: running(instance.appIds),
        flags: sectionFlags(sectionFacts(view, instance, instance.appIds, busy.get(instance.name))),
        collapsed: collapsed.has(instance.name),
      });
    }
    return out;
  };

  /** The sections on screen: all of them, or the one in focus. */
  const visibleSections = (): RowSection[] => {
    const all = sections();
    return focus === undefined ? all : all.filter((section) => section.instance === focus);
  };

  /** The worktree the dashboard was opened in, for as long as no instance runs from it. */
  const unregistered = (): UnregisteredWorktree | undefined => {
    const dir = opts.worktree;
    if (dir === undefined || worktreeCovered(snapshot, dir)) return undefined;
    return { dir, name: nameForWorktree(dir, snapshot) };
  };

  /**
   * Lets go of everything that was about an instance the workspace no longer
   * has: a menu, a form or a question left open on it would otherwise go on to
   * ask the daemon about a name that now means nothing — or, worse, about a
   * new instance somebody gave the same name.
   */
  const forgetGone = (): void => {
    const gone = (name: string | undefined): name is string =>
      name !== undefined && findInstance(snapshot, name) === undefined;
    for (const name of [...collapsed]) if (gone(name)) collapsed.delete(name);
    let lost: string | undefined;
    if (gone(focus)) {
      lost = focus;
      focus = undefined;
    }
    if (gone(paletteOn?.instance)) {
      lost = paletteOn?.instance;
      palette = undefined;
      paletteOn = undefined;
      if (mode === "palette") toList();
    }
    if (gone(menu?.instance)) {
      lost = menu?.instance;
      menu = undefined;
      if (mode === "instance") toList();
    }
    if (gone(detail?.instance)) {
      lost = detail?.instance;
      detail = undefined;
      if (mode === "detail") toList();
    }
    if (gone(form?.instance)) {
      lost = form?.instance;
      form = undefined;
      if (mode === "form") toList();
    }
    if (gone(confirm?.instance)) {
      lost = confirm?.instance;
      confirm = undefined;
      if (mode === "confirm") toList();
    }
    if (lost !== undefined) setNotice(`instance ${lost} is gone`, "warn");
  };

  const applySnapshot = (next: Snapshot): void => {
    // A section that appears while the others are folded arrives folded: ten
    // headings are the overview, and one expanded stranger would break it. The
    // one just asked for from here is the exception — the cursor is going there.
    if (collapseNew) {
      const known = new Set(snapshot.instances.map((i) => i.name));
      for (const instance of next.instances) {
        if (!known.has(instance.name) && sectionRowId(instance.name) !== landOn) collapsed.add(instance.name);
      }
    }
    snapshot = next;
    indicators.clear();
    for (const value of next.indicators) indicators.set(indicatorKey(value), value);
    services.clear();
    for (const service of next.services) services.set(service.targetId, service);
    pluginErrors.clear();
    for (const plugin of next.plugins) {
      if (!plugin.ok) pluginErrors.set(plugin.name, plugin.error ?? "failed to load");
    }
    configError = next.configError;
    rowsDirty = true;
    forgetGone();
    if (palette !== undefined) refreshPalette();
    if (profileMenu !== undefined) {
      profileMenu.index = clamp(profileMenu.index, 0, Math.max(0, next.profiles.length - 1));
    }
    if (menu !== undefined) refreshMenu();
    if (confirm?.lines !== undefined) confirm.state.lines = confirm.lines();
  };

  /** Instances in the order their sections are listed: base, then the others as created. */
  const sectionOrder = (): string[] => [
    BASE_INSTANCE,
    ...snapshot.instances.filter((instance) => !instance.isBase).map((instance) => instance.name),
  ];

  /**
   * Records the row under the cursor, by id and by where it sits. The section
   * is counted among all of them, not among the ones on screen: a focus hides
   * the neighbours, and they are still where the cursor goes if this one ends.
   */
  const remember = (): void => {
    const row = rows[cursor];
    selectedId = row?.id;
    if (row === undefined) {
      anchor = undefined;
      return;
    }
    const start = rows.findIndex((candidate) => candidate.instance === row.instance);
    anchor = {
      instance: row.instance,
      section: Math.max(0, sectionOrder().indexOf(row.instance)),
      offset: cursor - start,
    };
  };

  /**
   * Where the cursor goes when the row it was on no longer exists.
   *
   * Never "the same index": after a destroy that is some app of whichever
   * instance happened to move up, and the next key would act on it. An app
   * that left takes the cursor to its neighbour in the same section; a section
   * that left takes it to the heading that now stands where it stood, or to
   * the last one.
   */
  const fallbackCursor = (): number => {
    if (anchor === undefined) return cursor;
    const { instance, section, offset } = anchor;
    const start = rows.findIndex((row) => row.instance === instance);
    if (start >= 0) {
      let end = start;
      while (rows[end + 1]?.instance === instance) end += 1;
      return clamp(start + offset, start, end);
    }
    const order = sectionOrder();
    const heir = order[Math.min(section, order.length - 1)];
    const heading = heir === undefined ? -1 : rows.findIndex((row) => row.id === sectionRowId(heir));
    return Math.max(0, heading);
  };

  const rebuildRows = (): void => {
    rows = buildRows({
      repos: snapshot.repos,
      templates: snapshot.templates,
      sections: visibleSections(),
      headed: headed(),
      indicators: [...indicators.values()],
      color,
    });
    let found = landOn === undefined ? -1 : rows.findIndex((row) => row.id === landOn);
    if (found >= 0) landOn = undefined;
    else if (selectedId !== undefined) found = rows.findIndex((row) => row.id === selectedId);
    cursor = clamp(found >= 0 ? found : fallbackCursor(), 0, Math.max(0, rows.length - 1));
    remember();
    windowTop = windowTopFor(cursor, rows.length, viewport, windowTop);
  };

  const buildState = (): DashboardState => {
    const profile = activeProfile();
    // Everything listed, across instances: the header counts what is on screen.
    const selected = new Set(visibleSections().flatMap((section) => section.appIds));
    let running = 0;
    for (const service of services.values()) {
      if (selected.has(service.targetId) && service.status === "running") running += 1;
    }

    const progress: Record<TargetId, TaskTargetState> = {};
    for (const run of runs.values()) {
      for (const [targetId, targetState] of run.targets) progress[targetId] = targetState;
    }

    const profiles: ProfileOption[] = snapshot.profiles.map((p) => ({
      name: p.name,
      isDefault: p.isDefault,
      active: p.name === snapshot.activeProfile,
      targets: p.appIds.length,
    }));

    return {
      mode,
      help,
      connection,
      workspace: snapshot.workspace.name,
      daemonVersion: snapshot.daemonVersion,
      profile: profile.name,
      profiles,
      rows,
      cursor,
      windowTop,
      viewport,
      logViewport,
      running,
      total: selected.size,
      instances: snapshot.instances.length,
      focus,
      worktree: unregistered(),
      columns,
      configError,
      pluginErrors: [...pluginErrors].map(([plugin, error]) => ({ plugin, error })),
      notice,
      progress,
      activeRuns: runs.size,
      summary,
      logs,
      palette,
      profileMenu,
      instanceMenu: mode === "instance" ? menu : undefined,
      detail: detailState(),
      form: mode === "form" ? form?.state : undefined,
      confirm: mode === "confirm" ? confirm?.state : undefined,
      report: reportState(),
      activity: operations.activity(),
      exited,
    };
  };

  /** The detail view's lines, rebuilt each time: it is live while it is open. */
  const detailState = (): DetailState | undefined => {
    if (mode !== "detail" || detail === undefined) return undefined;
    const lines = wrapLines(
      detailLines({ snapshot: liveSnapshot(), instance: detail.instance, read: readIndicator, now: now() }),
      columns,
    );
    detail.top = clamp(detail.top, 0, Math.max(0, lines.length - viewport));
    return { instance: detail.instance, lines, top: detail.top };
  };

  const reportState = (): ReportState | undefined => {
    const current = reports[0];
    if (mode !== "report" || current === undefined) return undefined;
    const lines = wrapLines(current.lines, columns);
    const actions = current.followUps.map(({ key, label }) => ({ key, label }));
    reportTop = clamp(reportTop, 0, Math.max(0, lines.length - reportWindow(viewport, { actions })));
    return { title: current.title, ok: current.ok, lines, actions, top: reportTop, waiting: reports.length - 1 };
  };

  // --- publishing ----------------------------------------------------------

  const flush = (): void => {
    if (frame !== undefined) {
      frame();
      frame = undefined;
    }
    if (pendingLines.length > 0) {
      const batch = pendingLines.splice(0);
      if (logs !== undefined) seq = appendLogLines(logs, batch, scrollback, seq);
    }
    if (rowsDirty) {
      rebuildRows();
      rowsDirty = false;
    }
    state = buildState();
    for (const cb of [...listeners]) cb(state);
  };

  /** `immediate` is for anything the user just pressed; pushes wait for a frame. */
  const emit = (immediate: boolean): void => {
    if (disposed) return;
    if (immediate || frameMs === 0) {
      flush();
      return;
    }
    if (frame !== undefined) return;
    frame = schedule(() => {
      frame = undefined;
      flush();
    }, frameMs);
  };

  const setNotice = (text: string, tone: NoticeTone = "info"): void => {
    // A request that fails *after* teardown still lands here (the socket closing
    // is what rejected it), and arming a timer then would outlive the only thing
    // that knows how to cancel it.
    if (disposed) return;
    notice = { text, tone };
    noticeTimer?.();
    noticeTimer = schedule(() => {
      noticeTimer = undefined;
      notice = undefined;
      emit(false);
    }, NOTICE_TTL_MS);
  };

  const fail = (err: unknown): void => {
    setNotice(errorMessage(err), "error");
    emit(true);
  };

  // --- notifications -------------------------------------------------------

  disposers.push(
    client.on("indicator.changed", ({ values }) => {
      for (const value of values) indicators.set(indicatorKey(value), value);
      rowsDirty = true;
      emit(false);
    }),
    client.on("service.changed", ({ state: service }) => {
      services.set(service.targetId, service);
      rowsDirty = true;
      emit(false);
    }),
    client.on("log.line", ({ line }) => {
      if (logs === undefined || !logs.targets.includes(line.targetId)) return;
      pendingLines.push(line);
      emit(false);
    }),
    client.on("task.progress", ({ progress }) => {
      const run = runs.get(progress.runId) ?? { command: progress.command, targets: new Map() };
      run.targets.set(progress.targetId, progress.state);
      runs.set(progress.runId, run);
      // A heading names the run in flight on its instance, and headings are rows.
      if (headed()) rowsDirty = true;
      emit(false);
    }),
    client.on("task.finished", ({ result }) => {
      runs.delete(result.runId);
      summary = summarize(result);
      if (headed()) rowsDirty = true;
      emit(false);
    }),
    client.on("config.reloaded", (event) => {
      if (event.ok) {
        // Every instance mutation is a reload in the daemon. Said as what it
        // was — an instance appearing, an app leaving — whoever did it: with
        // several agents at work, most of these are somebody else's.
        const changes = event.snapshot === undefined ? [] : instanceChanges(snapshot, event.snapshot);
        if (event.snapshot !== undefined) applySnapshot(event.snapshot);
        configError = undefined;
        setNotice(changes.length === 0 ? "config reloaded" : describeChanges(changes));
      } else {
        configError = event.error ?? "config reload failed";
        setNotice("config reload failed — running the last-good config", "error");
      }
      emit(false);
    }),
    client.on("plugin.error", ({ plugin, error }) => {
      pluginErrors.set(plugin, error);
      emit(false);
    }),
    client.on("daemon.shutdown", ({ reason }) => {
      connection = "reconnecting";
      setNotice(`daemon stopped (${reason}) — reconnecting`, "warn");
      emit(false);
    }),
    client.onDisconnect(() => {
      if (connection === "lost") return;
      connection = "reconnecting";
      emit(false);
    }),
    client.onReattach((fresh) => {
      connection = "connected";
      // Whatever answered has no memory of a run that was in flight when the
      // connection dropped, so its `task.finished` is never coming; leaving the
      // progress up would strand `… running` on those rows for the session. A
      // run that really did survive re-announces itself on the next progress.
      runs.clear();
      applySnapshot(fresh);
      setNotice("reconnected to the daemon");
      emit(false);
    }),
    client.onLost((err) => {
      connection = "lost";
      setNotice(errorMessage(err), "error");
      emit(false);
    }),
  );

  // --- lifecycle actions ---------------------------------------------------

  const lifecycle = async (
    kind: "start" | "stop" | "restart",
    scope: ActionScope,
  ): Promise<void> => {
    const targets = scopeTargets(scope);
    if (targets !== undefined && targets.length === 0) {
      setNotice("nothing selected", "warn");
      emit(true);
      return;
    }
    summary = undefined;
    const instance = currentInstance();
    const label = targets === undefined ? scopeName() : describeTargets(targets);
    setNotice(`${LIFECYCLE_VERB[kind]} ${label}`);
    emit(true);
    try {
      if (kind === "start") await client.request("service.start", { targets, instance });
      else if (kind === "stop") await client.request("service.stop", { targets, instance });
      else await client.request("service.restart", { targets, instance });
    } catch (err) {
      fail(err);
    }
  };

  // --- log view ------------------------------------------------------------

  const releaseLogs = async (view: LogViewState): Promise<void> => {
    for (const targetId of view.targets) {
      await client.unsubscribe(targetId).catch(() => undefined);
    }
  };

  const openLogs = async (): Promise<void> => {
    const row = currentRow();
    if (row === undefined || row.targets.length === 0) {
      setNotice("nothing selected", "warn");
      emit(true);
      return;
    }
    const previous = logs;
    const targets = [...row.targets];
    const mine = ++generation;
    logs = {
      title: row.id,
      targets,
      prefix: targets.length > 1,
      lines: [],
      follow: true,
      loading: true,
      dropped: 0,
    };
    mode = "logs";
    pendingLines.length = 0;
    emit(true);
    if (previous !== undefined) await releaseLogs(previous);

    try {
      const collected: LogLine[] = [];
      for (const targetId of targets) {
        const { lines } = await client.request("logs.read", { targetId, lines: backfillLines });
        collected.push(...lines);
      }
      // Merged views interleave by time; a single stream is already in order.
      if (targets.length > 1) collected.sort((a, b) => a.ts - b.ts);
      if (generation !== mine || logs === undefined) return;
      seq = appendLogLines(logs, collected, scrollback, seq);
      logs.loading = false;
      emit(true);

      for (const targetId of targets) {
        await client.subscribe(targetId);
        if (generation !== mine) return;
      }
    } catch (err) {
      if (generation !== mine) return;
      if (logs !== undefined) logs.loading = false;
      fail(err);
    }
  };

  const closeLogs = async (): Promise<void> => {
    const view = logs;
    generation += 1;
    logs = undefined;
    pendingLines.length = 0;
    toList();
    emit(true);
    if (view !== undefined) await releaseLogs(view);
  };

  // --- palette -------------------------------------------------------------

  const refreshPalette = (): void => {
    const open = palette;
    const on = paletteOn;
    if (open === undefined || on === undefined) return;
    const inScope = new Set<TargetId>(open.scope === "profile" ? scopeAppIds(on.instance) : on.targets);
    const query = open.query.trim().toLowerCase();
    // Name matches rank above description matches: one letter of a query would
    // otherwise pull in every command whose sentence happens to contain it.
    const named: PaletteItem[] = [];
    const described: PaletteItem[] = [];
    for (const command of snapshot.commands) {
      const inName = command.name.toLowerCase().includes(query);
      const inDescription = (command.description ?? "").toLowerCase().includes(query);
      if (query.length > 0 && !inName && !inDescription) continue;
      (inName ? named : described).push({
        name: command.name,
        kind: command.kind,
        source: command.source,
        description: command.description,
        appliesTo: [...command.appliesTo],
        matched: command.appliesTo.filter((id) => inScope.has(id)),
      });
    }
    const items = [...named, ...described];
    open.items = items;
    open.index = clamp(open.index, 0, Math.max(0, items.length - 1));
    open.scopeLabel = open.scope === "profile" ? scopeName(on.instance) : describeTargets(on.targets);
  };

  const openPalette = (): void => {
    paletteOn = { instance: currentInstance(), targets: [...selectionTargets()] };
    palette = {
      query: "",
      index: 0,
      // A selection that resolves to nothing would make every command a no-op.
      scope: paletteOn.targets.length > 0 ? "selection" : "profile",
      scopeLabel: "",
      items: [],
    };
    refreshPalette();
    mode = "palette";
    emit(true);
  };

  const closePalette = (): void => {
    palette = undefined;
    paletteOn = undefined;
    toList();
    emit(true);
  };

  const paletteRun = async (): Promise<void> => {
    const open = palette;
    const on = paletteOn;
    const item = open?.items[open.index];
    if (open === undefined || on === undefined || item === undefined) return;
    const targets = open.scope === "profile" ? undefined : [...on.targets];
    const instance = on.instance;
    const label = open.scope === "profile" ? scopeName(instance) : describeTargets(targets ?? []);
    closePalette();
    summary = undefined;
    setNotice(`running ${item.name} on ${label}`);
    emit(true);
    try {
      await client.request("command.run", { command: item.name, targets, instance });
    } catch (err) {
      fail(err);
    }
  };

  // --- profile switcher ----------------------------------------------------

  const profilesSelect = async (): Promise<void> => {
    const menu = profileMenu;
    const chosen = menu === undefined ? undefined : snapshot.profiles[menu.index];
    if (chosen === undefined) return;
    profileMenu = undefined;
    toList();
    emit(true);
    if (chosen.name === snapshot.activeProfile) return;
    try {
      await client.request("profile.use", { name: chosen.name });
      // `profile.use` has no notification of its own — the new selection only
      // shows up in a fresh snapshot, so ask for one rather than guess.
      applySnapshot(await client.request("workspace.snapshot", {}));
      // A different list: where the cursor sat in the old one says nothing about it.
      selectedId = undefined;
      anchor = undefined;
      cursor = 0;
      windowTop = 0;
      setNotice(`profile ${chosen.name}`);
      emit(true);
    } catch (err) {
      fail(err);
    }
  };

  // --- modes ---------------------------------------------------------------

  /**
   * Back to the list — or to a result that has been waiting for it. Every way
   * out of a modal comes through here, which is what makes a finished action
   * impossible to miss: it is the next thing on screen, whatever was open when
   * it finished.
   */
  function toList(): void {
    if (reports.length > 0 && !help) {
      if (mode !== "report") reportTop = 0;
      mode = "report";
    } else {
      mode = "list";
    }
  }

  const announce = (text: string): void => {
    summary = undefined;
    setNotice(text);
  };

  // --- reports -------------------------------------------------------------

  const present = (report: Report): void => {
    if (disposed) return;
    reports.push(report);
    while (reports.length > MAX_REPORTS) reports.shift();
    if (mode === "list" || mode === "report") {
      toList();
    } else {
      // Not over what the user is in the middle of: it waits behind it.
      setNotice(`${report.title} — the result opens when you are back on the list`, report.ok ? "info" : "error");
    }
    emit(true);
  };

  /** A request the daemon would not take: its reason, whole, and whatever leads on from it. */
  const refused = (instance: string, title: string, refusal: Refusal, followUps: ReportFollowUp[] = []): void => {
    present({
      instance,
      title: `${title} — refused`,
      ok: false,
      lines: [{ text: refusal.message, tone: "error" }],
      followUps,
    });
  };

  /** Starts an action whose only way to be turned down is the daemon's. */
  const act = async (instance: string, title: string, start: Promise<Refusal | undefined>): Promise<void> => {
    const refusal = await start;
    if (refusal !== undefined) refused(instance, title, refusal);
  };

  /** Takes the result on screen off the queue; it stays reachable as the last one read. */
  const takeReport = (): void => {
    const current = reports.shift();
    if (current !== undefined) lastReport = current;
    reportTop = 0;
  };

  const dismissReport = (): void => {
    takeReport();
    if (mode === "report") toList();
    emit(true);
  };

  const operations = createOperations({
    client,
    live: liveSnapshot,
    apply: (fresh) => {
      applySnapshot(fresh);
    },
    alive: () => !disposed,
    changed: () => emit(false),
    report: present,
  });

  // --- instance menu -------------------------------------------------------

  /** Base ids, the way the config and every instance request spell them. */
  const baseIds = (ids: readonly TargetId[]): string[] => {
    const apps = new Map(snapshot.repos.flatMap((repo) => repo.apps).map((app) => [app.id, app.baseId]));
    return ids.map((id) => apps.get(id) ?? splitQualified(id).name);
  };

  const menuItems = (name: string): InstanceMenuItem[] => {
    const instance = findInstance(snapshot, name);
    const items: InstanceMenuItem[] = [];
    if (instance === undefined) return items;
    const isBase = instance.isBase;
    items.push({
      id: "details",
      key: "v",
      label: "details",
      hint: isBase ? "checkouts, ports and addresses" : "checkouts, ports, what it uses from base",
    });
    items.push({
      id: "up",
      key: "u",
      label: "up",
      hint: isBase ? "start the active profile and wait until it is ready" : "init if needed, start, wait until ready",
    });
    items.push({ id: "init", key: "i", label: "init", hint: "run the init steps again" });
    // Base is what u8.jsonc declares: nothing here adds to it, takes from it or destroys it.
    if (!isBase) {
      const addable = addableApps(snapshot, name).map((app) => app.id);
      items.push({
        id: "add",
        key: "a",
        label: "add apps…",
        hint: addable.join(", "),
        disabled: addable.length === 0 ? "it already runs every app the config declares" : undefined,
      });
      const selection = baseIds(menuSelection);
      items.push({
        id: "remove",
        key: "d",
        label: "remove apps…",
        hint: selection.length === 0 ? "choose which" : `${selection.join(", ")} (the selection)`,
      });
      const kept = keptCheckouts(snapshot, name);
      if (kept.length > 0) {
        items.push({
          id: "checkouts",
          key: "c",
          label: "give up a kept checkout…",
          hint: kept.map((checkout) => checkout.repo).join(", "),
        });
      }
      items.push({
        id: "destroy",
        key: "D",
        label: "destroy…",
        hint: "stop it, run teardown, remove the worktrees u8 created",
      });
    }
    items.push({ id: "new", key: "n", label: "new instance…", hint: "its own worktrees, ports and processes" });
    const worktree = unregistered();
    if (worktree !== undefined) {
      items.push({ id: "adopt", key: "w", label: "new instance from this worktree…", hint: worktree.dir });
    }
    if (lastReport !== undefined) items.push({ id: "result", key: "o", label: "last result", hint: lastReport.title });
    return items;
  };

  const menuSummary = (name: string): string => {
    const section = sections().find((candidate) => candidate.instance === name);
    return section === undefined ? "" : sectionSummary(section.running, section.appIds.length, section.flags ?? []);
  };

  /**
   * Keeps the highlight on the entry it was on. Entries come and go with the
   * snapshot — "give up a kept checkout…" appears above "destroy…" the moment a
   * remove finishes — and an index would leave Enter meaning something else
   * than what was highlighted a frame ago.
   */
  function refreshMenu(): void {
    if (menu === undefined) return;
    const highlighted = menu.items[menu.index]?.id;
    menu.items = menuItems(menu.instance);
    menu.summary = menuSummary(menu.instance);
    const at = menu.items.findIndex((item) => item.id === highlighted);
    menu.index = at >= 0 ? at : clamp(menu.index, 0, Math.max(0, menu.items.length - 1));
  }

  const openMenuFor = (instance: string): void => {
    const row = currentRow();
    // A heading selects the whole instance, and "remove everything" is destroy.
    menuSelection = row !== undefined && row.kind !== "instance" && row.instance === instance ? [...row.targets] : [];
    menu = { instance, summary: menuSummary(instance), items: menuItems(instance), index: 0 };
    mode = "instance";
    emit(true);
  };

  const instanceMenuRun = async (key?: string): Promise<void> => {
    const open = menu;
    if (open === undefined || mode !== "instance") return;
    const item = key === undefined ? open.items[open.index] : open.items.find((candidate) => candidate.key === key);
    if (item === undefined) return;
    if (item.disabled !== undefined) {
      setNotice(`${open.instance}: ${item.disabled}`, "warn");
      emit(true);
      return;
    }
    const instance = open.instance;
    const selection = baseIds(menuSelection);
    menu = undefined;
    switch (item.id) {
      case "details":
        detail = { instance, top: 0 };
        mode = "detail";
        emit(true);
        return;
      case "up":
        toList();
        announce(`bringing ${instance} up`);
        emit(true);
        return act(instance, `${instance} · up`, operations.up(instance));
      case "init":
        toList();
        announce(`running the init steps of ${instance}`);
        emit(true);
        return act(instance, `${instance} · init`, operations.init(instance));
      case "add":
        return openAddForm(instance);
      case "remove":
        return openRemoveForm(instance, selection);
      case "checkouts":
        return openCheckoutsForm(instance);
      case "destroy":
        return askDestroy(instance);
      case "new":
        return openCreateForm();
      case "adopt":
        return openAdoptForm();
      case "result":
        if (lastReport !== undefined) reports.unshift(lastReport);
        reportTop = 0;
        toList();
        emit(true);
        return;
    }
  };

  // --- forms ---------------------------------------------------------------

  /**
   * What became of a submitted form. Nothing: the action is under way. An
   * `error`: something to put right in the form — a field left empty, or the
   * daemon's refusal. A `refusal`: one that no edit of the form answers and
   * that has its own way on, so it is shown as a result.
   *
   * An answer rather than a side effect, because the form may not be on screen
   * any more when the daemon replies: whatever is open by then is the user's,
   * and only {@link formSubmit} knows whether this form still is.
   */
  type FormAnswer = undefined | { error: string } | { refusal: Refusal; title: string; followUps: ReportFollowUp[] };

  /** A form on screen and what submitting it does. */
  interface OpenForm {
    state: FormState;
    /** The instance it edits; it closes if that instance goes away. */
    instance?: string;
    submit(state: FormState): Promise<FormAnswer>;
  }

  const openForm = (
    state: Omit<FormState, "index" | "submitting">,
    submit: OpenForm["submit"],
    instance?: string,
  ): void => {
    // On what was ticked for the user, when something was: that is the line to check before Enter.
    const ticked = state.kind === "remove" ? state.fields.findIndex((field) => field.kind === "check" && field.checked) : -1;
    form = { state: { ...state, index: Math.max(0, ticked), submitting: false }, instance, submit };
    mode = "form";
    emit(true);
  };

  const textOf = (state: FormState, key: string): string | undefined => {
    const field = state.fields.find((candidate) => candidate.key === key);
    const value = field?.kind === "text" ? field.value.trim() : "";
    return value.length === 0 ? undefined : value;
  };

  const choiceOf = (state: FormState, key: string): string | undefined => {
    const field = state.fields.find((candidate) => candidate.key === key);
    return field?.kind === "choice" ? field.value : undefined;
  };

  const checkedOf = (state: FormState): string[] =>
    state.fields.flatMap((field) => (field.kind === "check" && field.checked ? [field.key] : []));

  /** Base's apps, as checkboxes named the way the config names them. */
  const appChecks = (ids: readonly string[], ticked: ReadonlySet<string>): FormField[] =>
    ids.map((id) => ({ kind: "check", key: id, label: id, checked: ticked.has(id) }));

  const branchFields = (branchDefault: string): FormField[] => [
    { kind: "text", key: "branch", label: "branch", value: "", placeholder: branchDefault },
    { kind: "text", key: "from", label: "from", value: "", placeholder: "the base checkout's HEAD — where a new branch starts" },
  ];

  const baseAppIds = (): string[] =>
    snapshot.repos.filter((repo) => repo.instance === BASE_INSTANCE).flatMap((repo) => repo.apps.map((app) => app.id));

  /** The cursor goes to an instance asked for from here, wherever the list was looking. */
  const landOnInstance = (name: string): void => {
    focus = undefined;
    collapsed.delete(name);
    landOn = sectionRowId(name);
    rowsDirty = true;
  };

  function openCreateForm(): void {
    openForm(
      {
        kind: "create",
        title: "new instance",
        intro: ["a git worktree per repo on its own branch, its own ports, then the init steps"],
        fields: [
          { kind: "text", key: "name", label: "name", value: "" },
          ...branchFields("the instance's name"),
          // What `u8 instance create <name>` would take with no targets: the profile on screen.
          ...appChecks(baseAppIds(), new Set(activeProfile().appIds)),
        ],
      },
      async (state) => {
        const name = textOf(state, "name");
        const targets = checkedOf(state);
        if (name === undefined) return { error: "give the instance a name" };
        if (targets.length === 0) return { error: "tick at least one app for it to run" };
        const refusal = await operations.create({
          name,
          targets,
          branch: textOf(state, "branch"),
          from: textOf(state, "from"),
        });
        if (refusal !== undefined) return { error: refusal.message };
        landOnInstance(name);
        return undefined;
      },
    );
  }

  function openAdoptForm(): void {
    const worktree = unregistered();
    if (worktree === undefined) return;
    openForm(
      {
        kind: "adopt",
        title: "new instance from this worktree",
        intro: [
          `uses ${worktree.dir} as it is — u8 never removes a worktree it did not create`,
          "then, as `u8 up` does: its own ports, the init steps, start, and wait until it is ready",
        ],
        fields: [
          { kind: "text", key: "name", label: "name", value: worktree.name },
          // None ticked is the daemon's own default, and the only one that
          // knows which repos a worktree holds.
          ...appChecks(baseAppIds(), new Set()).map((field) =>
            field.kind === "check" ? { ...field, note: "none ticked: every app this worktree holds" } : field,
          ),
        ],
      },
      async (state) => {
        const name = textOf(state, "name");
        const targets = checkedOf(state);
        if (name === undefined) return { error: "give the instance a name" };
        const refusal = await operations.create(
          { name, adopt: [worktree.dir], targets: targets.length === 0 ? undefined : targets },
          { thenStart: true },
        );
        if (refusal !== undefined) return { error: refusal.message };
        landOnInstance(name);
        return undefined;
      },
    );
  }

  function openAddForm(instance: string): void {
    const addable = addableApps(snapshot, instance).map((app) => app.id);
    openForm(
      {
        kind: "add",
        title: `add apps to ${instance}`,
        intro: [
          "a worktree for any repo it has no checkout of, ports for each app, then the init steps of what was added",
          "its other apps are rewired to the new copies; the ones running go stale until restarted",
        ],
        fields: [...appChecks(addable, new Set()), ...branchFields("the branch its other worktrees are on")],
      },
      async (state) => {
        const targets = checkedOf(state);
        if (targets.length === 0) return { error: "tick at least one app to add" };
        const refusal = await operations.add({
          name: instance,
          targets,
          branch: textOf(state, "branch"),
          from: textOf(state, "from"),
        });
        return refusal === undefined ? undefined : { error: refusal.message };
      },
      instance,
    );
  }

  /**
   * What a refused prune leads on to. When the daemon turned it down because
   * the worktree is not clean, that is the one thing that gets past it — and
   * only from there, with the daemon's list of what would be lost on screen.
   * Discard is never a choice in the form.
   */
  const afterRefusedPrune = (params: InstanceRemoveParams, refusal: Refusal): ReportFollowUp[] =>
    params.prune === true && refusal.code === "WORKTREE_FAILED"
      ? [
          {
            key: "D",
            label: "discard the uncommitted changes and remove the worktree…",
            action: { kind: "discard", params: { ...params, prune: true, discard: true } },
          },
        ]
      : [];

  function openRemoveForm(instance: string, selection: readonly string[]): void {
    const own = instanceApps(snapshot, instance).map((app) => app.baseId);
    openForm(
      {
        kind: "remove",
        title: `remove apps from ${instance}`,
        intro: [
          "stops them, runs their teardown steps and frees their ports",
          "its other apps go back to base's copies; the ones running go stale until restarted",
        ],
        fields: [
          ...appChecks(own, new Set(selection)),
          {
            kind: "choice",
            key: "checkout",
            label: "checkout of a repo left with no apps",
            options: [
              { value: "keep", label: "keep it" },
              { value: "prune", label: "give it up" },
            ],
            value: "keep",
            note: "given up: a worktree u8 created is removed only if git reports it clean; an adopted one is only forgotten",
          },
        ],
      },
      async (state) => {
        const targets = checkedOf(state);
        if (targets.length === 0) return { error: "tick at least one app to remove" };
        const params: InstanceRemoveParams = { name: instance, targets, prune: choiceOf(state, "checkout") === "prune" };
        const refusal = await operations.remove(params);
        if (refusal === undefined) return undefined;
        if (params.prune !== true || refusal.code !== "WORKTREE_FAILED") return { error: refusal.message };
        return {
          refusal,
          title: `${instance} · remove ${targets.join(", ")}`,
          followUps: afterRefusedPrune(params, refusal),
        };
      },
      instance,
    );
  }

  function openCheckoutsForm(instance: string): void {
    const kept = keptCheckouts(snapshot, instance);
    openForm(
      {
        kind: "checkouts",
        title: `give up checkouts ${instance} kept`,
        intro: [
          "a worktree u8 created is removed only if git reports it clean; an adopted one is forgotten and never touched",
        ],
        // Never ticked for the user, even when there is only one: this form's
        // Enter removes a worktree, and a tick is what makes it a decision.
        fields: kept.map((checkout) => ({
          kind: "check" as const,
          key: checkout.repo,
          label: checkout.repo,
          checked: false,
          note: `${checkout.path}${checkout.owned ? "" : " (adopted)"}`,
        })),
      },
      async (state) => {
        const targets = checkedOf(state);
        if (targets.length === 0) return { error: "tick at least one checkout to give up" };
        // The request names a repo, and for a repo the instance runs apps of it
        // means "remove those apps". If one came back while this was open, the
        // form no longer says what Enter would do.
        const still = new Set(keptCheckouts(snapshot, instance).map((checkout) => checkout.repo));
        const back = targets.filter((repo) => !still.has(repo));
        if (back.length > 0) {
          return {
            error: `${back.join(", ")} ${back.length === 1 ? "is" : "are"} no longer a checkout without apps — ${instance} runs from ${back.length === 1 ? "it" : "them"} again. Close this and look again.`,
          };
        }
        const params: InstanceRemoveParams = { name: instance, targets, prune: true };
        const refusal = await operations.remove(params);
        if (refusal === undefined) return undefined;
        return {
          refusal,
          title: `${instance} · give up ${targets.join(", ")}`,
          followUps: afterRefusedPrune(params, refusal),
        };
      },
      instance,
    );
  }

  const formSubmit = async (): Promise<void> => {
    const open = form;
    if (open === undefined || open.state.submitting) return;
    open.state.submitting = true;
    open.state.error = undefined;
    emit(true);
    let answer: FormAnswer;
    try {
      answer = await open.submit(open.state);
    } catch (err) {
      answer = { error: errorMessage(err) };
    }
    if (disposed) return;
    open.state.submitting = false;
    // Escaped while the request was out, and perhaps something else opened
    // since: the answer still has to land somewhere, but not on top of that.
    const onScreen = form === open;
    if (answer === undefined) {
      if (onScreen) {
        form = undefined;
        toList();
      }
    } else if ("error" in answer) {
      if (onScreen) open.state.error = answer.error;
      else refused(open.instance ?? "", open.state.title, { message: answer.error });
    } else {
      if (onScreen) {
        form = undefined;
        mode = "list";
      }
      refused(open.instance ?? "", answer.title, answer.refusal, answer.followUps);
    }
    emit(true);
  };

  const currentField = (): FormField | undefined => form?.state.fields[form.state.index];

  // --- confirmation --------------------------------------------------------

  /** A question on screen, and what a yes does. */
  interface OpenConfirm {
    state: ConfirmState;
    /** The instance it is about; it closes if that instance goes away. */
    instance: string;
    /**
     * What will happen, read off the snapshot again. A question that lists
     * the worktrees a destroy removes is answered seconds after it is asked,
     * and what it lists has to be what is there then.
     */
    lines?: () => ToneLine[];
    run(): void;
  }

  const ask = (
    instance: string,
    state: Omit<ConfirmState, "typed" | "lines"> & { lines: ToneLine[] | (() => ToneLine[]) },
    run: () => void,
  ): void => {
    const lines = typeof state.lines === "function" ? state.lines : undefined;
    confirm = {
      state: { ...state, lines: lines === undefined ? (state.lines as ToneLine[]) : lines(), typed: "" },
      instance,
      lines,
      run,
    };
    mode = "confirm";
    emit(true);
  };

  const confirmed = (): void => {
    const open = confirm;
    if (open === undefined) return;
    confirm = undefined;
    open.run();
    toList();
    emit(true);
  };

  function askDestroy(instance: string): void {
    ask(
      instance,
      {
        title: `destroy instance ${instance}`,
        lines: () => destroyLines(liveSnapshot(), instance, readIndicator),
        expect: instance,
        verb: "destroy it",
      },
      () => {
        announce(`destroying ${instance}`);
        void act(instance, `${instance} · destroy`, operations.destroy(instance));
      },
    );
  }

  const reportAct = async (key: string): Promise<void> => {
    const current = reports[0];
    if (mode !== "report" || current === undefined) return;
    const followUp = current.followUps.find((candidate) => candidate.key === key);
    if (followUp === undefined) return;
    const action = followUp.action;
    switch (action.kind) {
      case "restart": {
        dismissReport();
        announce(`restarting ${describeTargets(action.targets)}`);
        emit(true);
        try {
          await client.request("service.restart", { targets: action.targets, instance: action.instance });
        } catch (err) {
          fail(err);
        }
        return;
      }
      case "discard": {
        const { params } = action;
        const targets = params.targets.join(", ");
        return ask(
          params.name,
          {
            title: `discard uncommitted changes — ${params.name}`,
            lines: [
              ...current.lines,
              { text: "", tone: "plain" },
              {
                text: `removes the worktree ${targets} leaves behind with everything uncommitted in it; git is not asked again, and nothing brings it back`,
                tone: "error",
              },
            ],
            expect: params.name,
            verb: "discard and remove",
          },
          () => {
            takeReport();
            announce(`removing ${targets} from ${params.name}, discarding uncommitted changes`);
            void operations.remove(params).then((refusal) => {
              if (refusal !== undefined) refused(params.name, `${params.name} · remove ${targets}`, refusal);
            });
          },
        );
      }
      case "force-remove": {
        const { params } = action;
        const targets = params.targets.join(", ");
        const lines: ToneLine[] = [
          {
            text: "drops the apps from the instance anyway: whatever the failed step was meant to undo stays as it is",
            tone: "warn",
          },
        ];
        // The request being forced is the one that failed, checkout and all —
        // so the question says what it carries, and is as hard to answer as
        // the hardest part of it. A discard was typed for once already, but
        // for the worktree as it was then.
        if (params.discard === true) {
          lines.push({
            text: `and removes the worktree ${targets} leaves behind with everything uncommitted in it — as it is now, not as it was when this was first asked`,
            tone: "error",
          });
        } else if (params.prune === true) {
          lines.push({
            text: "and gives up the checkout of a repo left with no apps: a worktree u8 created is removed if git reports it clean",
            tone: "warn",
          });
        }
        return ask(
          params.name,
          {
            title: `remove ${targets} from ${params.name} although teardown failed`,
            lines,
            expect: params.discard === true ? params.name : undefined,
            verb: "force the removal",
          },
          () => {
            takeReport();
            announce(`removing ${targets} from ${params.name} (forced)`);
            void operations.remove(params).then((refusal) => {
              if (refusal === undefined) return;
              refused(params.name, `${params.name} · remove ${targets}`, refusal, afterRefusedPrune(params, refusal));
            });
          },
        );
      }
      case "force-destroy": {
        const { instance } = action;
        return ask(
          instance,
          {
            title: `destroy instance ${instance} although teardown failed`,
            lines: () => [
              ...destroyLines(liveSnapshot(), instance, readIndicator),
              {
                text: "the failed teardown step is not run again: whatever it was meant to undo stays as it is",
                tone: "warn",
              },
            ],
            expect: instance,
            verb: "force the destroy",
          },
          () => {
            takeReport();
            announce(`destroying ${instance} (forced)`);
            void act(instance, `${instance} · destroy`, operations.destroy(instance, { force: true }));
          },
        );
      }
    }
  };

  // --- controller ----------------------------------------------------------

  const controller: DashboardController = {
    getState: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    handleKey(input, key) {
      if (exited || disposed) return;
      dispatchKey(controller, state, input, key);
    },

    setViewport(height) {
      const next = Math.max(1, Math.floor(height));
      if (next === viewport) return;
      viewport = next;
      windowTop = windowTopFor(cursor, rows.length, viewport, windowTop);
      emit(true);
    },
    setLogViewport(height) {
      const next = Math.max(1, Math.floor(height));
      if (next === logViewport) return;
      logViewport = next;
      emit(true);
    },
    setColumns(width) {
      const next = Math.max(20, Math.floor(width));
      if (next === columns) return;
      columns = next;
      emit(true);
    },

    moveCursor(delta) {
      controller.setCursor(cursor + delta);
    },
    setCursor(index) {
      if (rows.length === 0) return;
      const next = clamp(index, 0, rows.length - 1);
      if (next === cursor) return;
      cursor = next;
      remember();
      windowTop = windowTopFor(cursor, rows.length, viewport, windowTop);
      if (palette !== undefined) refreshPalette();
      emit(true);
    },
    jumpSection(delta) {
      const headings: number[] = [];
      rows.forEach((row, index) => {
        if (row.kind === "instance") headings.push(index);
      });
      // Backwards from inside a section is its own heading first, the way a
      // "previous paragraph" motion stops at the start of the one it is in.
      const target = delta > 0 ? headings.find((index) => index > cursor) : headings.reverse().find((index) => index < cursor);
      if (target !== undefined) controller.setCursor(target);
    },
    collapseSection() {
      const instance = currentInstance();
      if (!headed() || collapsed.has(instance)) return;
      collapsed.add(instance);
      // The rows under the cursor are about to go; the heading is what is left of them.
      selectedId = sectionRowId(instance);
      rowsDirty = true;
      emit(true);
    },
    expandSection() {
      if (!collapsed.delete(currentInstance())) return;
      rowsDirty = true;
      emit(true);
    },
    toggleAllSections() {
      if (!headed()) return;
      const names = visibleSections().map((section) => section.instance);
      if (names.every((name) => collapsed.has(name))) {
        for (const name of names) collapsed.delete(name);
        collapseNew = false;
      } else {
        for (const name of names) collapsed.add(name);
        collapseNew = true;
        selectedId = sectionRowId(currentInstance());
      }
      rowsDirty = true;
      emit(true);
    },
    toggleFocus() {
      if (!headed()) return;
      if (focus === undefined) {
        focus = currentInstance();
        // Focusing on a folded section to look at a heading would be no focus at all.
        collapsed.delete(focus);
        setNotice(`showing ${focus} only — f shows every instance again`);
      } else {
        focus = undefined;
        setNotice("showing every instance");
      }
      rowsDirty = true;
      emit(true);
    },

    start: (scope) => lifecycle("start", scope),
    stop: (scope) => lifecycle("stop", scope),
    restart: (scope) => lifecycle("restart", scope),

    openLogs,
    closeLogs,
    scrollLogs(delta) {
      if (logs === undefined) return;
      scrollLogView(logs, delta, logViewport);
      emit(true);
    },
    logsTop() {
      if (logs === undefined) return;
      logViewTop(logs);
      emit(true);
    },
    logsBottom() {
      if (logs === undefined) return;
      logViewBottom(logs);
      emit(true);
    },

    openPalette,
    closePalette,
    paletteType(text) {
      if (palette === undefined) return;
      palette.query += text;
      palette.index = 0;
      refreshPalette();
      emit(true);
    },
    paletteBackspace() {
      if (palette === undefined || palette.query.length === 0) return;
      palette.query = palette.query.slice(0, -1);
      palette.index = 0;
      refreshPalette();
      emit(true);
    },
    paletteMove(delta) {
      if (palette === undefined || palette.items.length === 0) return;
      palette.index = clamp(palette.index + delta, 0, palette.items.length - 1);
      emit(true);
    },
    paletteToggleScope() {
      if (palette === undefined) return;
      palette.scope = palette.scope === "profile" ? "selection" : "profile";
      refreshPalette();
      emit(true);
    },
    paletteRun,

    openProfiles() {
      const index = Math.max(
        0,
        snapshot.profiles.findIndex((p) => p.name === snapshot.activeProfile),
      );
      profileMenu = { index };
      mode = "profiles";
      emit(true);
    },
    closeProfiles() {
      profileMenu = undefined;
      toList();
      emit(true);
    },
    profilesMove(delta) {
      if (profileMenu === undefined || snapshot.profiles.length === 0) return;
      profileMenu.index = clamp(profileMenu.index + delta, 0, snapshot.profiles.length - 1);
      emit(true);
    },
    profilesSelect,

    openInstanceMenu() {
      openMenuFor(currentInstance());
    },
    closeInstanceMenu() {
      menu = undefined;
      toList();
      emit(true);
    },
    instanceMenuMove(delta) {
      if (menu === undefined || menu.items.length === 0) return;
      menu.index = clamp(menu.index + delta, 0, menu.items.length - 1);
      emit(true);
    },
    instanceMenuRun,

    closeDetail() {
      detail = undefined;
      toList();
      emit(true);
    },
    detailScroll(delta) {
      if (detail === undefined) return;
      detail.top = Math.max(0, detail.top + delta);
      emit(true);
    },
    detailTop() {
      if (detail === undefined) return;
      detail.top = 0;
      emit(true);
    },
    detailBottom() {
      if (detail === undefined) return;
      detail.top = BOTTOM;
      emit(true);
    },
    detailActions() {
      const instance = detail?.instance;
      if (instance === undefined) return;
      detail = undefined;
      openMenuFor(instance);
    },

    formMove(delta) {
      const open = form?.state;
      if (open === undefined || open.submitting || open.fields.length === 0) return;
      open.index = clamp(open.index + delta, 0, open.fields.length - 1);
      emit(true);
    },
    formType(text) {
      const field = currentField();
      if (form?.state.submitting === true || field?.kind !== "text") return;
      field.value += text;
      emit(true);
    },
    formBackspace() {
      const field = currentField();
      if (form?.state.submitting === true || field?.kind !== "text" || field.value.length === 0) return;
      field.value = field.value.slice(0, -1);
      emit(true);
    },
    formToggle() {
      const field = currentField();
      if (form?.state.submitting === true || field === undefined) return;
      if (field.kind === "check") field.checked = !field.checked;
      else if (field.kind === "choice") controller.formCycle(1);
      emit(true);
    },
    formCycle(delta) {
      const field = currentField();
      if (form?.state.submitting === true || field?.kind !== "choice" || field.options.length === 0) return;
      const at = field.options.findIndex((option) => option.value === field.value);
      const next = field.options[(at + delta + field.options.length) % field.options.length];
      if (next !== undefined) field.value = next.value;
      emit(true);
    },
    formSubmit,
    closeForm() {
      form = undefined;
      toList();
      emit(true);
    },

    confirmType(text) {
      if (confirm === undefined || confirm.state.expect === undefined) return;
      confirm.state.typed += text;
      emit(true);
    },
    confirmBackspace() {
      if (confirm === undefined || confirm.state.typed.length === 0) return;
      confirm.state.typed = confirm.state.typed.slice(0, -1);
      emit(true);
    },
    confirmAccept() {
      const open = confirm?.state;
      // Enter alone never answers a y/n question: it is the key most often
      // pressed without reading what is on screen.
      if (open === undefined || open.expect === undefined) return;
      if (open.typed !== open.expect) {
        setNotice(`type ${open.expect} exactly to ${open.verb} — esc cancels`, "warn");
        emit(true);
        return;
      }
      confirmed();
    },
    confirmYes() {
      if (confirm === undefined || confirm.state.expect !== undefined) return;
      confirmed();
    },
    closeConfirm() {
      confirm = undefined;
      toList();
      emit(true);
    },

    reportScroll(delta) {
      if (mode !== "report") return;
      reportTop = Math.max(0, reportTop + delta);
      emit(true);
    },
    reportTop() {
      reportTop = 0;
      emit(true);
    },
    reportBottom() {
      reportTop = BOTTOM;
      emit(true);
    },
    reportAct,
    dismissReport,

    toggleHelp() {
      help = !help;
      // A result that arrived behind the overlay is next, as it would have been.
      if (!help && mode === "list") toList();
      emit(true);
    },
    dismissNotice() {
      if (notice === undefined) return;
      noticeTimer?.();
      noticeTimer = undefined;
      notice = undefined;
      emit(true);
    },
    quit() {
      exited = true;
      emit(true);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Same fence a second `openLogs` raises: an open still waiting on its
      // backfill must not go on to subscribe to something nobody will unsubscribe.
      generation += 1;
      frame?.();
      frame = undefined;
      noticeTimer?.();
      noticeTimer = undefined;
      for (const off of disposers.splice(0)) off();
      listeners.clear();
      const view = logs;
      logs = undefined;
      if (view !== undefined) await releaseLogs(view);
    },
  };

  applySnapshot(snapshot);
  flush();
  return controller;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIFECYCLE_VERB = {
  start: "starting",
  stop: "stopping",
  restart: "restarting",
} as const;

/** `feat-x gained api; instance agent-2 created; and 3 more changes` — one notice, however busy the reload. */
function describeChanges(changes: readonly string[]): string {
  if (changes.length <= MAX_CHANGES_IN_NOTICE) return changes.join("; ");
  const rest = changes.length - MAX_CHANGES_IN_NOTICE;
  return `${changes.slice(0, MAX_CHANGES_IN_NOTICE).join("; ")}; and ${rest} more change${rest === 1 ? "" : "s"}`;
}

/** `platform.web`, or `3 targets` once naming them all would not fit a line. */
export function describeTargets(targets: readonly TargetId[]): string {
  if (targets.length === 0) return "nothing";
  if (targets.length === 1) return targets[0] ?? "nothing";
  if (targets.length === 2) return targets.join(", ");
  return `${targets.length} targets`;
}

function summarize(result: TaskResult): RunSummary {
  const tally = new Map<TaskTargetState, number>();
  for (const target of result.targets) {
    tally.set(target.state, (tally.get(target.state) ?? 0) + 1);
  }
  return {
    runId: result.runId,
    command: result.command,
    ok: result.ok,
    counts: [...tally].map(([state, count]) => ({ state, count })),
    durationMs: Math.max(0, result.finishedAt - result.startedAt),
  };
}
