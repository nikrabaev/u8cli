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

export type { Unsubscribe };

/**
 * The parts of an attached connection the dashboard uses.
 *
 * Narrower than {@link AttachedClient} on purpose: a fake implementing this is
 * a plain object, while faking the transport underneath it is not.
 */
export interface DashboardClient {
  /** The latest snapshot the attach produced; refreshed on every re-attach. */
  snapshot(): Snapshot;
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
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
    request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      return attached.client.request(method, params);
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

/** Which surface owns the body of the screen and the keyboard. */
export type Mode = "list" | "logs" | "palette" | "profiles";

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
  running: number;
  total: number;
  /** How many instances the workspace has, base included. */
  instances: number;
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
  /** The app has asked to quit; the Ink root unmounts on it. */
  exited: boolean;
}
