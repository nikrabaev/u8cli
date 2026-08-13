/**
 * Unix-socket JSON-RPC client.
 *
 * Every failure mode a caller cares about is surfaced as a `U8Error`: an absent
 * or refused socket becomes `DAEMON_UNREACHABLE` (the CLI's cue to spawn a
 * daemon), and a server-side failure keeps the daemon's original `U8ErrorCode`
 * so error handling reads the same on both sides of the socket.
 */
import net from "node:net";

import { U8Error, errorMessage, type U8ErrorCode } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";
import { LineDecoder, encodeMessage } from "./framing.js";
import type {
  RpcErrorBody,
  RpcMethod,
  RpcNotification,
  RpcNotificationPayload,
  RpcParams,
  RpcResponseEnvelope,
  RpcResult,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 250;

/** Connect errors that mean "no daemon here", as opposed to a broken one. */
const UNREACHABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EACCES"]);

/** A JSON-RPC error response, rehydrated with the daemon's own error code. */
export class RpcRemoteError extends U8Error {
  readonly rpcCode: number;

  constructor(body: RpcErrorBody) {
    super((body.data?.u8Code as U8ErrorCode | undefined) ?? "RPC_ERROR", body.message, body.data?.details);
    this.name = "RpcRemoteError";
    this.rpcCode = body.code;
  }
}

export interface RpcClientOptions {
  socketPath: string;
  /** Per-request deadline. `0` disables it. Defaults to 15s. */
  timeoutMs?: number;
  logger?: Logger;
  /** Fires once per dropped connection, including one the daemon closed on us. */
  onClose?: (err?: Error) => void;
  maxLineBytes?: number;
}

export interface RpcClient {
  readonly socketPath: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** Subscribes to a server push; returns the unsubscribe function. */
  on<N extends RpcNotification>(name: N, cb: (params: RpcNotificationPayload<N>) => void): () => void;
  onClose(cb: (err?: Error) => void): () => void;
  close(): Promise<void>;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

class Client implements RpcClient {
  readonly socketPath: string;

  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #maxLineBytes: number | undefined;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<(params: never) => void>>();
  readonly #closeListeners = new Set<(err?: Error) => void>();

  #socket: net.Socket | undefined;
  #connecting: Promise<void> | undefined;
  #open = false;
  #userClosed = false;
  #lastError: Error | undefined;
  #seq = 0;

  constructor(opts: RpcClientOptions) {
    this.socketPath = opts.socketPath;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = opts.logger ?? nullLogger;
    this.#maxLineBytes = opts.maxLineBytes;
    if (opts.onClose) this.#closeListeners.add(opts.onClose);
  }

  get connected(): boolean {
    return this.#open;
  }

  connect(): Promise<void> {
    if (this.#userClosed) {
      return Promise.reject(new U8Error("DAEMON_UNREACHABLE", "rpc client is closed"));
    }
    if (this.#open) return Promise.resolve();
    if (this.#connecting) return this.#connecting;

    this.#connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const cleanup = (): void => {
        socket.off("error", onError);
        socket.off("connect", onConnect);
      };
      const onError = (err: Error): void => {
        cleanup();
        socket.on("error", () => {}); // a late error on the discarded socket must not crash us
        socket.destroy();
        reject(connectError(err, this.socketPath));
      };
      const onConnect = (): void => {
        cleanup();
        this.#adopt(socket);
        resolve();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    }).finally(() => {
      this.#connecting = undefined;
    });

    return this.#connecting;
  }

  async request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (!this.#open) await this.connect();
    const socket = this.#socket;
    if (!socket || !this.#open) {
      throw new U8Error("DAEMON_UNREACHABLE", `not connected to ${this.socketPath}`);
    }

    const id = this.#nextId();
    // Encode before the request is registered: a params value JSON cannot express
    // must fail as a U8Error, not leave a pending entry nobody will ever settle.
    let frame: string;
    try {
      frame = encodeMessage({ jsonrpc: "2.0", id, method, params });
    } catch (e) {
      throw new U8Error("RPC_ERROR", `params for ${method} are not serializable: ${errorMessage(e)}`);
    }

    return new Promise<RpcResult<M>>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        fn();
      };

      let timer: NodeJS.Timeout | undefined;
      if (this.#timeoutMs > 0) {
        timer = setTimeout(() => {
          settle(() =>
            reject(new U8Error("RPC_ERROR", `${method} timed out after ${this.#timeoutMs}ms`)),
          );
        }, this.#timeoutMs);
        timer.unref();
      }

      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      socket.write(frame, (err) => {
        if (!err) return;
        settle(() =>
          reject(new U8Error("DAEMON_UNREACHABLE", `failed to send ${method}: ${err.message}`)),
        );
      });
    });
  }

  on<N extends RpcNotification>(name: N, cb: (params: RpcNotificationPayload<N>) => void): () => void {
    const set = this.#listeners.get(name) ?? new Set<(params: never) => void>();
    this.#listeners.set(name, set);
    // Wrapped so each subscription is a distinct set member: registering the same
    // function twice must yield two independent subscriptions, not one shared one.
    const entry = (params: never): void => {
      (cb as (p: unknown) => void)(params);
    };
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0) this.#listeners.delete(name);
    };
  }

  onClose(cb: (err?: Error) => void): () => void {
    this.#closeListeners.add(cb);
    return () => {
      this.#closeListeners.delete(cb);
    };
  }

  close(): Promise<void> {
    this.#userClosed = true;
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      this.#teardown();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
      timer.unref();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  /** Monotonic so a late response from a dead connection can never alias a new one. */
  #nextId(): number {
    this.#seq += 1;
    return this.#seq;
  }

  #adopt(socket: net.Socket): void {
    if (this.#userClosed) {
      // close() landed while the connect was in flight; do not keep the socket alive.
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    this.#socket = socket;
    this.#open = true;
    this.#lastError = undefined;
    socket.setNoDelay(true);

    const decoder = new LineDecoder(this.#maxLineBytes);
    socket.on("data", (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        if (!msg.ok) {
          this.#logger.warn("dropping unparsable frame from daemon", msg.error.message);
          continue;
        }
        this.#handleMessage(msg.value);
      }
    });
    socket.on("error", (err: Error) => {
      // Errors always precede 'close'; recording is all we may safely do here.
      this.#lastError = err;
      this.#logger.debug("socket error", err.message);
    });
    socket.on("close", () => {
      this.#teardown(this.#lastError);
    });
  }

  #handleMessage(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const env = value as Partial<RpcResponseEnvelope> & { method?: unknown };

    if (typeof env.method === "string" && env.id === undefined) {
      this.#emit(env.method, (value as { params?: unknown }).params);
      return;
    }
    if (typeof env.id !== "number") return;

    const pending = this.#pending.get(env.id);
    if (!pending) {
      this.#logger.debug(`response for unknown request id ${env.id}`);
      return;
    }
    this.#pending.delete(env.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (env.error) pending.reject(new RpcRemoteError(env.error));
    else pending.resolve(env.result);
  }

  #emit(name: string, params: unknown): void {
    const set = this.#listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as (p: unknown) => void)(params);
      } catch (e) {
        this.#logger.error(`notification listener for ${name} threw`, e);
      }
    }
  }

  #teardown(err?: Error): void {
    const wasOpen = this.#open;
    this.#open = false;
    this.#socket = undefined;

    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(
        new U8Error(
          "DAEMON_UNREACHABLE",
          `connection to ${this.socketPath} closed before ${p.method} completed`,
          err?.message,
        ),
      );
    }

    if (!wasOpen) return;
    for (const cb of [...this.#closeListeners]) {
      try {
        cb(err);
      } catch (e) {
        this.#logger.error("onClose listener threw", e);
      }
    }
  }
}

export function createRpcClient(opts: RpcClientOptions): RpcClient {
  return new Client(opts);
}

function connectError(err: Error, socketPath: string): U8Error {
  const code = typeof (err as NodeJS.ErrnoException).code === "string" ? (err as NodeJS.ErrnoException).code : undefined;
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return new U8Error("DAEMON_UNREACHABLE", `no daemon listening on ${socketPath}`, { code });
  }
  return new U8Error("RPC_ERROR", `failed to connect to ${socketPath}: ${err.message}`, { code });
}
