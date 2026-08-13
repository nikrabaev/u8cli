/** Error taxonomy shared across every layer. */

export type U8ErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "CONFIG_PARSE"
  | "UNKNOWN_TARGET"
  | "UNKNOWN_COMMAND"
  | "UNKNOWN_PROFILE"
  | "DAEMON_UNREACHABLE"
  | "DAEMON_VERSION_MISMATCH"
  | "RPC_ERROR"
  | "PROCESS_FAILED"
  | "PLUGIN_LOAD"
  | "DEPENDENCY_TIMEOUT"
  | "HOOK_ABORTED"
  | "INTERNAL";

/** Base error carrying a stable machine-readable code. */
export class U8Error extends Error {
  readonly code: U8ErrorCode;
  readonly details?: unknown;

  constructor(code: U8ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "U8Error";
    this.code = code;
    this.details = details;
  }
}

/** A single validation problem, addressed by its path within the config document. */
export interface ConfigIssue {
  /** Dotted path, e.g. `apps.gateway.subapps.web.path`. */
  path: string;
  message: string;
}

/** Aggregate of every problem found while loading/validating a workspace config. */
export class ConfigError extends U8Error {
  readonly issues: ConfigIssue[];
  readonly configPath: string | undefined;

  constructor(message: string, issues: ConfigIssue[], configPath?: string) {
    super("CONFIG_INVALID", message, issues);
    this.name = "ConfigError";
    this.issues = issues;
    this.configPath = configPath;
  }

  /** Multi-line, human-readable rendering used by the CLI and the TUI banner. */
  format(): string {
    const head = this.configPath ? `${this.message} (${this.configPath})` : this.message;
    if (this.issues.length === 0) return head;
    return [head, ...this.issues.map((i) => `  • ${i.path ? `${i.path}: ` : ""}${i.message}`)].join("\n");
  }
}

export function isU8Error(e: unknown): e is U8Error {
  return e instanceof U8Error;
}

/** Normalizes anything thrown into a message string. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
