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
import type { CommandKind, CommandSource, TargetId, Templates } from "../config/types.js";

/** Bumped on breaking wire changes; checked during the attach handshake. */
export const PROTOCOL_VERSION = 2;

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
  id: TargetId;
  repoName: string;
  name: string;
  implicit: boolean;
  cwd: string;
  template?: string;
  hasHealth: boolean;
  dependsOn: TargetId[];
  /** Script names available (for palette hints). */
  scripts: string[];
}

export interface SnapshotRepo {
  name: string;
  path: string;
  template?: string;
  apps: SnapshotApp[];
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
  repos: SnapshotRepo[];
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

  /** Targets are raw strings (`repo`, `repo.app`); empty means the active profile. */
  "service.start": { params: { targets?: string[] }; result: { runId: string } };
  "service.stop": { params: { targets?: string[] }; result: { runId: string } };
  "service.restart": { params: { targets?: string[] }; result: { runId: string } };

  "command.run": {
    params: { command: string; targets?: string[]; serial?: boolean; concurrency?: number };
    result: { runId: string };
  };
  /** Resolves when the run finishes; safe to call after completion (results are retained). */
  "run.await": { params: { runId: string }; result: TaskResult };

  "logs.read": { params: { targetId: TargetId; lines?: number; runId?: string }; result: { lines: LogLine[] } };
  "logs.subscribe": { params: { targetId: TargetId }; result: { ok: true } };
  "logs.unsubscribe": { params: { targetId: TargetId }; result: { ok: true } };

  "indicators.list": { params: Record<string, never>; result: { indicators: IndicatorValue[] } };
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
