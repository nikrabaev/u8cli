/**
 * The dashboard's data shapes: the client seam the controller talks to, and the
 * snapshot-shaped state the Ink components render.
 *
 * The split is what makes the TUI testable without a terminal *and* without a
 * daemon. The controller only ever sees {@link DashboardClient} — a handful of
 * methods a fake satisfies in a few lines — and every component reads
 * {@link DashboardState} and nothing else, so a render test is a pure function
 * of a state object.
 */
import type { CommandKind, CommandSource, TargetId } from "../config/types.js";
import type { AttachedClient, Unsubscribe } from "../daemon/index.js";
import type { RpcRequestOptions } from "../ipc/index.js";
import type {
  LogStream,
  RpcMethod,
  RpcNotification,
  RpcNotificationPayload,
  RpcParams,
  RpcResult,
  Snapshot,
  TaskTargetState,
} from "../ipc/protocol.js";
import type { DashboardRow } from "./rows.js";

export type { RpcRequestOptions, Unsubscribe };

/**
 * The parts of an attached connection the dashboard uses.
 *
 * Narrower than {@link AttachedClient} on purpose: a fake implementing this is
 * a plain object, while faking the transport underneath it is not.
 */
export interface DashboardClient {
  /** The latest snapshot the attach produced; refreshed on every re-attach. */
  snapshot(): Snapshot;
  /**
   * `opts.timeoutMs: 0` is for the requests that answer when the work does —
   * a worktree being made, a run being awaited — rather than within a deadline.
   */
  request<M extends RpcMethod>(method: M, params: RpcParams<M>, opts?: RpcRequestOptions): Promise<RpcResult<M>>;
  on<N extends RpcNotification>(name: N, cb: (params: RpcNotificationPayload<N>) => void): Unsubscribe;
  subscribe(targetId: TargetId): Promise<void>;
  unsubscribe(targetId: TargetId): Promise<void>;
  /** The socket dropped; `attach` is already trying to get back in. */
  onDisconnect(cb: () => void): Unsubscribe;
  onReattach(cb: (snapshot: Snapshot) => void): Unsubscribe;
  onLost(cb: (err: Error) => void): Unsubscribe;
}

/** Adapts the real attached connection to the seam above. */
export function dashboardClient(attached: AttachedClient): DashboardClient {
  return {
    snapshot: () => attached.snapshot(),
    request<M extends RpcMethod>(method: M, params: RpcParams<M>, opts?: RpcRequestOptions): Promise<RpcResult<M>> {
      return attached.client.request(method, params, opts);
    },
    on: (name, cb) => attached.on(name, cb),
    subscribe: (targetId) => attached.subscribe(targetId),
    unsubscribe: (targetId) => attached.unsubscribe(targetId),
    onDisconnect: (cb) => attached.client.onClose(() => cb()),
    onReattach: (cb) => attached.onReattach(cb),
    onLost: (cb) => attached.onLost(cb),
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The key flags the dashboard reads. Structurally a subset of Ink's `Key`, so
 * `useInput`'s argument passes straight through and a test can synthesize one
 * with a single field.
 */
export interface TuiKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Which surface owns the body of the screen and the keyboard.
 *
 * `instance` is the menu of things to do with one instance and `detail` what it
 * is made of; `form` and `confirm` are the two ways an action asks before it
 * acts, and `report` is how it says what happened.
 */
export type Mode = "list" | "logs" | "palette" | "profiles" | "instance" | "detail" | "form" | "confirm" | "report";

/** `reconnecting` is recoverable and expected; `lost` means attach gave up. */
export type ConnectionState = "connected" | "reconnecting" | "lost";

export type NoticeTone = "info" | "warn" | "error";

/** One transient line under the list: the answer to the last thing you pressed. */
export interface Notice {
  text: string;
  tone: NoticeTone;
}

export interface ProfileOption {
  name: string;
  isDefault: boolean;
  active: boolean;
  /** Apps the profile selects. */
  targets: number;
}

export interface PluginFailure {
  plugin: string;
  error: string;
}

/** A scrollback line. `seq` is monotonic and survives eviction, so it anchors scroll. */
export interface LogEntry {
  seq: number;
  targetId: TargetId;
  stream: LogStream;
  ts: number;
  text: string;
}

export interface LogViewState {
  /** The row the view was opened from — a repo name or a target id. */
  title: string;
  targets: TargetId[];
  /** Prefix lines with their target id; only true when the view merges streams. */
  prefix: boolean;
  /** Bounded scrollback, oldest first. */
  lines: LogEntry[];
  /** Bottom-anchored. Scrolling up pauses follow; `G` resumes it. */
  follow: boolean;
  /** Sequence of the top visible line while paused. */
  topSeq?: number;
  /** True until the backfill lands. */
  loading: boolean;
  /** Lines evicted by the scrollback cap, for the "…" marker. */
  dropped: number;
}

export type PaletteScope = "selection" | "profile";

export interface PaletteItem {
  name: string;
  kind: CommandKind;
  source: CommandSource;
  description?: string;
  /** Every target the command resolves a script for. */
  appliesTo: TargetId[];
  /** Of {@link appliesTo}, the ones inside the current scope. */
  matched: TargetId[];
}

export interface PaletteState {
  query: string;
  index: number;
  scope: PaletteScope;
  /** What the scope resolves to right now, e.g. `platform.web` or `profile full`. */
  scopeLabel: string;
  /** Commands matching {@link query}: name hits first, then description hits. */
  items: PaletteItem[];
}

export interface ProfileMenuState {
  index: number;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/** How a line of a report or a detail view is to be read at a glance. */
export type LineTone = "plain" | "title" | "ok" | "warn" | "error" | "dim";

export interface ToneLine {
  text: string;
  tone: LineTone;
}

export type InstanceActionId =
  | "details"
  | "up"
  | "init"
  | "add"
  | "remove"
  | "checkouts"
  | "destroy"
  | "new"
  | "adopt"
  | "result";

export interface InstanceMenuItem {
  id: InstanceActionId;
  /** The letter that runs it without moving to it. */
  key: string;
  label: string;
  hint: string;
  /** Why it cannot be run right now; the entry is drawn, and says so. */
  disabled?: string;
}

/** The things to do with one instance. Captured when it opens: the cursor may move underneath it. */
export interface InstanceMenuState {
  instance: string;
  /** The heading's own summary, repeated so the menu says what it is about. */
  summary: string;
  items: InstanceMenuItem[];
  index: number;
}

/** What an instance is made of, as lines; live while it is open. */
export interface DetailState {
  instance: string;
  lines: ToneLine[];
  /** First visible line. */
  top: number;
}

export type FormField =
  | { kind: "text"; key: string; label: string; value: string; placeholder?: string }
  | { kind: "check"; key: string; label: string; checked: boolean; note?: string }
  | {
      kind: "choice";
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      value: string;
      note?: string;
    };

/** A handful of fields answered before an action is sent. */
export interface FormState {
  kind: "create" | "adopt" | "add" | "remove" | "checkouts";
  title: string;
  /** Said under the title: what submitting will do. */
  intro: string[];
  fields: FormField[];
  index: number;
  /** Why the last submission did not go through, as the daemon worded it. */
  error?: string;
  /** The request is with the daemon; keys other than escape wait for it. */
  submitting: boolean;
}

/**
 * The question before something that cannot be taken back.
 *
 * `expect` set means the answer has to be typed — the instance's name — and
 * unset means `y`. Enter alone never confirms a `y` question.
 */
export interface ConfirmState {
  title: string;
  /** What will happen, in full. */
  lines: ToneLine[];
  expect?: string;
  typed: string;
  /** What `y`, or the typed name and Enter, does: the verb on the prompt line. */
  verb: string;
}

/** Something a report offers to do next. */
export interface ReportAction {
  key: string;
  label: string;
}

/** How an instance action ended: every line of it, and what can follow. */
export interface ReportState {
  title: string;
  ok: boolean;
  lines: ToneLine[];
  actions: ReportAction[];
  top: number;
  /** Other results queued behind this one. */
  waiting: number;
}

/** A worktree of the workspace that no instance covers, which the dashboard was opened in. */
export interface UnregisteredWorktree {
  dir: string;
  /** The name an instance made from it would get by default. */
  name: string;
}

export interface RunSummary {
  runId: string;
  command: string;
  ok: boolean;
  /** Per-outcome tally, in the order the states first appeared. */
  counts: Array<{ state: TaskTargetState; count: number }>;
  durationMs: number;
}

/**
 * Everything on screen, in one object.
 *
 * Rebuilt whole on every flush rather than mutated, so `useSyncExternalStore`
 * can compare references and components never read a half-updated view.
 */
export interface DashboardState {
  mode: Mode;
  /** The help overlay floats above whatever mode is active. */
  help: boolean;
  connection: ConnectionState;
  workspace: string;
  daemonVersion: string;
  profile: string;
  profiles: ProfileOption[];
  rows: DashboardRow[];
  cursor: number;
  /** First visible row: the list renders `rows.slice(windowTop, windowTop + viewport)`. */
  windowTop: number;
  /** Rows the list may draw; the log view has its own, usually taller, window. */
  viewport: number;
  logViewport: number;
  /** The terminal's width; panels of text are wrapped to it. */
  columns: number;
  running: number;
  total: number;
  /** How many instances the workspace has, base included. */
  instances: number;
  /** The one instance the list is narrowed to, when it is. */
  focus?: string;
  /** Set while the worktree the dashboard was opened in still has no instance. */
  worktree?: UnregisteredWorktree;
  /** Set while the daemon is running its last-good config (SPEC §8). */
  configError?: string;
  pluginErrors: PluginFailure[];
  notice?: Notice;
  /** Per-target state of every in-flight run, drawn inline on the rows. */
  progress: Record<TargetId, TaskTargetState>;
  activeRuns: number;
  summary?: RunSummary;
  logs?: LogViewState;
  palette?: PaletteState;
  profileMenu?: ProfileMenuState;
  instanceMenu?: InstanceMenuState;
  detail?: DetailState;
  form?: FormState;
  confirm?: ConfirmState;
  report?: ReportState;
  /** Instance actions still in flight, one line each: `feat-x: adding api — instance:init`. */
  activity: string[];
  /** The app has asked to quit; the Ink root unmounts on it. */
  exited: boolean;
}
