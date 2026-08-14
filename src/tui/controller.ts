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
 *    finished runs are dropped from the progress map.
 *  - **A dropped daemon is a banner, not a crash.** `attach` re-attaches (and
 *    respawns) underneath; the controller only tracks which of the three
 *    connection states to draw and re-applies whatever snapshot comes back.
 */
import type { TargetId } from "../config/types.js";
import type {
  IndicatorValue,
  LogLine,
  ServiceState,
  Snapshot,
  SnapshotProfile,
  TaskResult,
  TaskTargetState,
} from "../ipc/protocol.js";
import { errorMessage } from "../util/errors.js";
import { dispatchKey } from "./keymap.js";
import { appendLogLines, logViewBottom, logViewTop, scrollLogView } from "./logs.js";
import { buildRows, indicatorKey, type DashboardRow } from "./rows.js";
import { clamp, windowTopFor } from "./scroll.js";
import type {
  ConnectionState,
  DashboardClient,
  DashboardState,
  LogViewState,
  Mode,
  Notice,
  NoticeTone,
  PaletteItem,
  PaletteState,
  ProfileOption,
  RunSummary,
  TuiKey,
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
  /** The TUI owns a terminal, so this defaults to true. */
  color?: boolean;
  /** Minimum gap between push-driven re-renders. */
  frameMs?: number;
  scrollback?: number;
  backfill?: number;
  scheduler?: Scheduler;
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

  moveCursor(delta: number): void;
  setCursor(index: number): void;

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
  let profileMenu: { index: number } | undefined;

  let rows: DashboardRow[] = [];
  let cursor = 0;
  /** Sticky selection across rebuilds: the row id, not its index. */
  let selectedId: string | undefined;
  let viewport = INITIAL_VIEWPORT;
  let logViewport = INITIAL_VIEWPORT;
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
      subappIds: [],
    };

  const currentRow = (): DashboardRow | undefined => rows[cursor];

  const selectionTargets = (): TargetId[] => currentRow()?.targets ?? [];

  const scopeTargets = (scope: ActionScope): TargetId[] | undefined =>
    scope === "profile" ? undefined : [...selectionTargets()];

  const applySnapshot = (next: Snapshot): void => {
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
    if (palette !== undefined) refreshPalette();
    if (profileMenu !== undefined) {
      profileMenu.index = clamp(profileMenu.index, 0, Math.max(0, next.profiles.length - 1));
    }
  };

  const rebuildRows = (): void => {
    const profile = activeProfile();
    rows = buildRows({
      apps: snapshot.apps,
      templates: snapshot.templates,
      profile,
      indicators: [...indicators.values()],
      color,
    });
    const found = selectedId === undefined ? -1 : rows.findIndex((row) => row.id === selectedId);
    cursor = found >= 0 ? found : clamp(cursor, 0, Math.max(0, rows.length - 1));
    selectedId = rows[cursor]?.id;
    windowTop = windowTopFor(cursor, rows.length, viewport, windowTop);
  };

  const buildState = (): DashboardState => {
    const profile = activeProfile();
    const selected = new Set(profile.subappIds);
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
      targets: p.subappIds.length,
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
      total: profile.subappIds.length,
      configError,
      pluginErrors: [...pluginErrors].map(([plugin, error]) => ({ plugin, error })),
      notice,
      progress,
      activeRuns: runs.size,
      summary,
      logs,
      palette,
      profileMenu,
      exited,
    };
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
      emit(false);
    }),
    client.on("task.finished", ({ result }) => {
      runs.delete(result.runId);
      summary = summarize(result);
      emit(false);
    }),
    client.on("config.reloaded", (event) => {
      if (event.ok) {
        if (event.snapshot !== undefined) applySnapshot(event.snapshot);
        configError = undefined;
        setNotice("config reloaded");
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
    const label = targets === undefined ? `profile ${activeProfile().name}` : describeTargets(targets);
    setNotice(`${LIFECYCLE_VERB[kind]} ${label}`);
    emit(true);
    try {
      if (kind === "start") await client.request("service.start", { targets });
      else if (kind === "stop") await client.request("service.stop", { targets });
      else await client.request("service.restart", { targets });
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
    mode = "list";
    emit(true);
    if (view !== undefined) await releaseLogs(view);
  };

  // --- palette -------------------------------------------------------------

  const refreshPalette = (): void => {
    const open = palette;
    if (open === undefined) return;
    const inScope = new Set<TargetId>(
      open.scope === "profile" ? activeProfile().subappIds : selectionTargets(),
    );
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
    open.scopeLabel =
      open.scope === "profile"
        ? `profile ${activeProfile().name}`
        : describeTargets(selectionTargets());
  };

  const openPalette = (): void => {
    palette = {
      query: "",
      index: 0,
      // A selection that resolves to nothing would make every command a no-op.
      scope: selectionTargets().length > 0 ? "selection" : "profile",
      scopeLabel: "",
      items: [],
    };
    refreshPalette();
    mode = "palette";
    emit(true);
  };

  const closePalette = (): void => {
    palette = undefined;
    mode = "list";
    emit(true);
  };

  const paletteRun = async (): Promise<void> => {
    const open = palette;
    const item = open?.items[open.index];
    if (open === undefined || item === undefined) return;
    const targets = open.scope === "profile" ? undefined : [...selectionTargets()];
    const label = open.scope === "profile" ? `profile ${activeProfile().name}` : describeTargets(targets ?? []);
    closePalette();
    summary = undefined;
    setNotice(`running ${item.name} on ${label}`);
    emit(true);
    try {
      await client.request("command.run", { command: item.name, targets });
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
    mode = "list";
    emit(true);
    if (chosen.name === snapshot.activeProfile) return;
    try {
      await client.request("profile.use", { name: chosen.name });
      // `profile.use` has no notification of its own — the new selection only
      // shows up in a fresh snapshot, so ask for one rather than guess.
      applySnapshot(await client.request("workspace.snapshot", {}));
      selectedId = undefined;
      cursor = 0;
      windowTop = 0;
      setNotice(`profile ${chosen.name}`);
      emit(true);
    } catch (err) {
      fail(err);
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

    moveCursor(delta) {
      controller.setCursor(cursor + delta);
    },
    setCursor(index) {
      if (rows.length === 0) return;
      const next = clamp(index, 0, rows.length - 1);
      if (next === cursor) return;
      cursor = next;
      selectedId = rows[cursor]?.id;
      windowTop = windowTopFor(cursor, rows.length, viewport, windowTop);
      if (palette !== undefined) refreshPalette();
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
      mode = "list";
      emit(true);
    },
    profilesMove(delta) {
      if (profileMenu === undefined || snapshot.profiles.length === 0) return;
      profileMenu.index = clamp(profileMenu.index + delta, 0, snapshot.profiles.length - 1);
      emit(true);
    },
    profilesSelect,

    toggleHelp() {
      help = !help;
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
