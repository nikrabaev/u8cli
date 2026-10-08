/**
 * Wire contract between clients (TUI, headless CLI) and the workspace daemon.
 *
 * Transport: a unix socket carrying newline-delimited JSON-RPC 2.0. Requests get
 * responses; the daemon additionally pushes unsolicited notifications (indicator
 * deltas, log lines, task progress) over the same connection.
 *
 * This file is the single source of truth for both sides — it must not import
 * anything but types, so both the daemon and thin clients can depend on it.
 */
import type { CommandKind, CommandSource, InstanceRepoRecord, TargetId, Templates } from "../config/types.js";

/** Bumped on breaking wire changes; checked during the attach handshake. */
export const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Core value types
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a supervised service process.
 *
 * Note: `stale` is *not* in this union — staleness is orthogonal to lifecycle and
 * lives in `ServiceState.stale`. The `app@status` indicator collapses the two and
 * reports `"stale"` for a running-but-outdated process, which is what the spec's
 * user-facing status enum describes.
 */
export type ServiceStatus = "stopped" | "starting" | "running" | "crashed" | "stopping";

export interface ServiceState {
  targetId: TargetId;
  status: ServiceStatus;
  /** Running with a spawn-time definition that no longer matches the config. */
  stale: boolean;
  pid?: number;
  /** Epoch ms of the current run's spawn. */
  startedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** Consecutive auto-restart attempts; reset once the process stays up. */
  restartAttempts: number;
  /** Populated on crash / failed start. */
  lastError?: string;
}

export type IndicatorTone = "ok" | "warn" | "error" | "muted" | "info";

/** One resolved indicator cell. `owner` is a repo name or a target id per `scope`. */
export interface IndicatorValue {
  /** Empty for an indicator declared in config, which a template writes bare: `{version}`. */
  ns: string;
  name: string;
  scope: "repo" | "app";
  owner: string;
  /** Raw value — what `--json` and modifiers like `max()` operate on. */
  value: string;
  /** Optional pre-rendered text (e.g. `●` for status) used instead of `value`. */
  display?: string;
  tone?: IndicatorTone;
}

export type LogStream = "stdout" | "stderr" | "u8";

export interface LogLine {
  targetId: TargetId;
  /** Set for task-run logs; absent for service logs. */
  runId?: string;
  stream: LogStream;
  ts: number;
  text: string;
}

export type TaskTargetState = "pending" | "running" | "skipped" | "ok" | "failed" | "aborted";

export interface TaskProgress {
  runId: string;
  command: string;
  targetId: TargetId;
  state: TaskTargetState;
  exitCode?: number | null;
  durationMs?: number;
  /** Reason for `failed` / `aborted` (e.g. a pre-hook rejection). */
  error?: string;
}

export interface TaskTargetResult {
  targetId: TargetId;
  state: TaskTargetState;
  exitCode?: number | null;
  durationMs: number;
  error?: string;
  /** Path of the captured per-target run log, when one was written. */
  logPath?: string;
}

export interface TaskResult {
  runId: string;
  command: string;
  ok: boolean;
  targets: TaskTargetResult[];
  startedAt: number;
  finishedAt: number;
}

// ---------------------------------------------------------------------------
// Snapshot — everything a client needs to render, in one payload
// ---------------------------------------------------------------------------

export interface SnapshotApp {
  /** Instance-qualified outside base: `api@feat-x`. */
  id: TargetId;
  /** The id as the config spells it, whichever instance this copy is in. */
  baseId: TargetId;
  instance: string;
  repoName: string;
  name: string;
  implicit: boolean;
  cwd: string;
  /** Named ports as this copy has them; the first is its primary one. */
  ports: Record<string, number>;
  template?: string;
  hasHealth: boolean;
  dependsOn: TargetId[];
  /** Script names available (for palette hints). */
  scripts: string[];
}

export interface SnapshotRepo {
  /** Instance-qualified outside base: `platform@feat-x`. */
  name: string;
  /** The repo's key in the config. */
  baseName: string;
  instance: string;
  path: string;
  template?: string;
  apps: SnapshotApp[];
}

export interface SnapshotInstance {
  name: string;
  isBase: boolean;
  createdAt: number;
  /** Qualified ids of the apps this instance runs. */
  appIds: TargetId[];
  /** Its checkouts by qualified repo name; empty for base. */
  checkouts: Record<string, InstanceRepoRecord>;
  /** Whether its init steps have completed; always true for base. */
  initialized: boolean;
}

export interface SnapshotProfile {
  name: string;
  isDefault: boolean;
  appIds: TargetId[];
}

export interface SnapshotCommand {
  name: string;
  kind: CommandKind;
  source: CommandSource;
  description?: string;
  /** Targets this command actually resolves a script for. */
  appliesTo: TargetId[];
}

export interface SnapshotPlugin {
  name: string;
  spec: string;
  ok: boolean;
  error?: string;
}

export interface Snapshot {
  protocolVersion: number;
  daemonVersion: string;
  workspace: { id: string; name: string; rootDir: string; configPath: string };
  templates: Templates;
  /** Every instance's repos: base first, then the others in creation order. */
  repos: SnapshotRepo[];
  /** Base first. Never empty. */
  instances: SnapshotInstance[];
  /** Profiles select among base apps; an instance's selection is its own app list. */
  profiles: SnapshotProfile[];
  activeProfile: string;
  commands: SnapshotCommand[];
  services: ServiceState[];
  indicators: IndicatorValue[];
  plugins: SnapshotPlugin[];
  /** Formatted message when the last reload failed and last-good config is in use. */
  configError?: string;
}

export interface DaemonStatus {
  version: string;
  protocolVersion: number;
  pid: number;
  uptimeMs: number;
  workspaceId: string;
  configPath: string;
  runningServices: number;
  clients: number;
  idleExitInMs: number | null;
}

// ---------------------------------------------------------------------------
// Method map
// ---------------------------------------------------------------------------

export interface RpcMethods {
  "daemon.ping": { params: Record<string, never>; result: { pong: true; version: string; protocolVersion: number } };
  "daemon.status": { params: Record<string, never>; result: DaemonStatus };
  "daemon.stop": { params: { force?: boolean }; result: { ok: true } };

  /** Registers this connection for push notifications and returns the full state. */
  "client.attach": { params: { clientVersion: string; interactive?: boolean }; result: Snapshot };

  "workspace.snapshot": { params: Record<string, never>; result: Snapshot };
  "workspace.reload": { params: Record<string, never>; result: { ok: boolean; error?: string } };

  "profile.use": { params: { name: string }; result: { ok: true; activeProfile: string } };

  /**
   * Targets are raw strings (`repo`, `repo.app`), read from inside `instance`
   * (base when omitted): a bare name is that instance's copy, and reaching
   * another takes an explicit `name@instance`. No targets means the active
   * profile in base and every app of the instance anywhere else.
   */
  "service.start": { params: { targets?: string[]; instance?: string; wait?: boolean }; result: { runId: string } };
  "service.stop": { params: { targets?: string[]; instance?: string }; result: { runId: string } };
  "service.restart": { params: { targets?: string[]; instance?: string; wait?: boolean }; result: { runId: string } };

  "command.run": {
    params: { command: string; targets?: string[]; instance?: string; serial?: boolean; concurrency?: number };
    result: { runId: string };
  };

  /**
   * Creates an instance: a checkout per repo (a new worktree, or an existing
   * one adopted as it is), ports for every app, and the record that makes its
   * apps exist. `runId` is the init run — awaiting it is how a client knows the
   * instance is ready to start.
   */
  "instance.create": { params: InstanceCreateParams; result: { instance: SnapshotInstance; runId: string } };
  /** Stops its services, runs teardown, removes the worktrees u8 created, frees its ports. */
  "instance.destroy": { params: { name: string; force?: boolean }; result: { runId: string } };
  /** Re-runs the init steps of an existing instance. */
  "instance.init": { params: { name: string }; result: { runId: string } };
  /** Resolves when the run finishes; safe to call after completion (results are retained). */
  "run.await": { params: { runId: string }; result: TaskResult };

  "logs.read": { params: { targetId: TargetId; lines?: number; runId?: string }; result: { lines: LogLine[] } };
  "logs.subscribe": { params: { targetId: TargetId }; result: { ok: true } };
  "logs.unsubscribe": { params: { targetId: TargetId }; result: { ok: true } };

  "indicators.list": { params: Record<string, never>; result: { indicators: IndicatorValue[] } };
}

export interface InstanceCreateParams {
  name: string;
  /** Repos and/or apps, as written in the config. Empty means the active profile. */
  targets?: string[];
  /**
   * Existing git worktrees to use as they are. Each one covers every repo of the
   * workspace that lives in the same git repository, so a tool that made one
   * worktree of a monorepo does not have to know how the config slices it.
   */
  adopt?: string[];
  /** An existing directory for one repo, by repo name — for a clone git cannot relate to base. */
  paths?: Record<string, string>;
  /** Branch for new worktrees; defaults to the instance name. */
  branch?: string;
  /** Start point for a branch that does not exist yet; defaults to the base checkout's HEAD. */
  from?: string;
  /** Overrides for `${vars.<name>}`. */
  vars?: Record<string, string>;
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];

// ---------------------------------------------------------------------------
// Notification map
// ---------------------------------------------------------------------------

export interface RpcNotifications {
  "indicator.changed": { values: IndicatorValue[] };
  "service.changed": { state: ServiceState };
  "log.line": { line: LogLine };
  "task.progress": { progress: TaskProgress };
  "task.finished": { result: TaskResult };
  "config.reloaded": { ok: boolean; error?: string; stale: TargetId[]; snapshot?: Snapshot };
  "plugin.error": { plugin: string; error: string };
  "daemon.shutdown": { reason: string };
}

export type RpcNotification = keyof RpcNotifications;
export type RpcNotificationPayload<N extends RpcNotification> = RpcNotifications[N];

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface RpcRequestEnvelope {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcErrorBody {
  code: number;
  message: string;
  /** Carries the `U8ErrorCode` when the failure originated from a U8Error. */
  data?: { u8Code?: string; details?: unknown };
}

export interface RpcResponseEnvelope {
  jsonrpc: "2.0";
  /** `null` for errors raised before an id could be read (unparsable frames). */
  id: number | null;
  result?: unknown;
  error?: RpcErrorBody;
}

export interface RpcNotificationEnvelope {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type RpcEnvelope = RpcRequestEnvelope | RpcResponseEnvelope | RpcNotificationEnvelope;

/** JSON-RPC reserved codes plus one application code for U8Errors. */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  APPLICATION_ERROR: -32000,
} as const;

export function isRequest(e: RpcEnvelope): e is RpcRequestEnvelope {
  return "method" in e && "id" in e;
}

export function isResponse(e: RpcEnvelope): e is RpcResponseEnvelope {
  return !("method" in e) && "id" in e;
}

export function isNotification(e: RpcEnvelope): e is RpcNotificationEnvelope {
  return "method" in e && !("id" in e);
}
