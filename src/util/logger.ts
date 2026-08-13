/**
 * Minimal leveled logger. The daemon's stdout/stderr is redirected to
 * `daemon.log`, so writing to the console is the whole implementation.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

function currentLevel(): LogLevel {
  const raw = (process.env.U8_LOG_LEVEL ?? "info").toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "info";
}

export function createLogger(scope = "u8"): Logger {
  const write = (level: LogLevel, msg: string, meta?: unknown): void => {
    if (ORDER[level] < ORDER[currentLevel()]) return;
    const ts = new Date().toISOString();
    const suffix = meta === undefined ? "" : ` ${safeJson(meta)}`;
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${suffix}`;
    if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? val.message : val)) ?? "";
  } catch {
    return String(v);
  }
}

/** Discards everything — used in tests and by `--quiet` paths. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => nullLogger,
};
