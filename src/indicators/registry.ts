/**
 * The indicator registry: every provider, the current value per owner, and the
 * scheduling that keeps them fresh.
 *
 * Four rules shape the implementation:
 *  - **One value per (ns, name, owner).** Owners are app names for app-scoped
 *    providers and target ids for subapp-scoped ones, derived from the workspace
 *    on every activation so a config reload re-binds without a restart.
 *  - **Nothing enters the cache unsanitized.** Values are arbitrary command
 *    stdout; see `sanitize.ts`.
 *  - **A bad provider is a blank cell, never an outage.** Throws and timeouts
 *    yield an empty value plus a warning, and never touch a neighbour.
 *  - **Every timer and subscription has an owner that disposes it.** Timers are
 *    unref'd — indicators must not keep the daemon alive — and `stop()` leaves
 *    none behind.
 */
import type { NormalizedSubapp, NormalizedWorkspace, TargetId } from "../config/types.js";
import type { IndicatorRegistration, IndicatorRegistry, Unsubscribe } from "../daemon/contracts.js";
import type { IndicatorTone, IndicatorValue } from "../ipc/protocol.js";
import type {
  IndicatorContext,
  IndicatorDef,
  IndicatorResult,
  IndicatorScope,
  IndicatorUpdate,
  TargetInfo,
} from "../plugin/types.js";
import { exec } from "../process/index.js";
import type { ExecOptions, ExecResult } from "../process/types.js";
import { errorMessage } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { coreIndicators } from "./core.js";
import { CUSTOM_NAMESPACE, customIndicators } from "./custom.js";
import { sanitizeIndicatorText } from "./sanitize.js";
import type { IndicatorRegistryDeps } from "./types.js";

/**
 * Changes are coalesced for this long before an `onChange` emission. Starting a
 * profile flips status, pid and uptime on a dozen targets within microseconds of
 * each other; the TUI should re-render once, not forty times.
 */
export const CHANGE_BATCH_MS = 10;

/** Same idea for `refresh()`: a wave of supervisor transitions is one pass. */
export const REFRESH_COALESCE_MS = 5;

/** Gap between two owners' first poll, so 20 targets do not fire in one tick. */
export const STAGGER_STEP_MS = 25;

/** Bounds on how long a pull provider may take before its value is dropped. */
export const MAX_PROVIDER_TIMEOUT_MS = 5_000;
export const MIN_PROVIDER_TIMEOUT_MS = 200;

/** `IndicatorDef.update` default when a provider only defines `value`. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

const TONES: ReadonlySet<string> = new Set<IndicatorTone>(["ok", "warn", "error", "muted", "info"]);

interface OwnerState {
  readonly owner: string;
  value?: IndicatorValue;
  /** First (staggered) poll; replaced by `pollTimer` once it fires. */
  startTimer?: NodeJS.Timeout;
  pollTimer?: NodeJS.Timeout;
  disposer?: () => void;
  /** Aborts whatever this cell has in flight — `ctx.exec` children above all. */
  abort?: AbortController;
  /** Guards against overlapping evaluations of the same cell. */
  running: boolean;
  /**
   * A forced re-evaluation arrived mid-run and must happen once this one lands:
   * the run in flight read the world *before* the event that triggered it, and an
   * event-mode cell has no timer that would ever correct it.
   */
  queued: boolean;
  /** Bumped on deactivation so in-flight results and late emits are discarded. */
  generation: number;
}

interface ProviderEntry {
  readonly key: string;
  readonly ns: string;
  readonly name: string;
  readonly scope: IndicatorScope;
  readonly logger: Logger;
  def: IndicatorDef;
  update: IndicatorUpdate;
  timeoutMs: number;
  /** Keyed by owner, in workspace order. */
  owners: Map<string, OwnerState>;
}

type Settled<T> = { state: "ok"; value: T } | { state: "error"; error: unknown } | { state: "timeout" };

/**
 * Creates the registry. Core `app@` providers are registered immediately and
 * config-declared `x@` providers are derived from the workspace on every
 * `start()` / `rebind()`, so the daemon only has to add plugin providers.
 */
export function createIndicatorRegistry(deps: IndicatorRegistryDeps): IndicatorRegistry {
  return new Registry(deps);
}

class Registry implements IndicatorRegistry {
  private readonly logger: Logger;
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly listeners = new Set<(values: IndicatorValue[]) => void>();
  /** Per-namespace scratch space handed to providers as `ctx.store`. */
  private readonly stores = new Map<string, Map<string, unknown>>();
  /** Changed cells awaiting emission, keyed so a cell appears once per payload. */
  private readonly pending = new Map<string, IndicatorValue>();
  /** Expires an outstanding provider deadline early, so `stop()` leaves none. */
  private readonly deadlines = new Set<() => void>();
  private batchTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshPending: Set<TargetId> | "all" | undefined;
  private active = false;

  constructor(private readonly deps: IndicatorRegistryDeps) {
    this.logger = deps.logger.child("indicators");
    for (const reg of coreIndicators(deps)) this.upsert(reg);
  }

  // --- registration --------------------------------------------------------

  register(reg: IndicatorRegistration): void {
    const entry = this.upsert(reg);
    if (!this.active) return;
    // A plugin registering into a live registry (hot reload) must start ticking
    // now; re-activating from scratch also picks up a changed interval.
    for (const state of entry.owners.values()) deactivate(state, this.logger);
    this.detach(this.activateEntry(entry));
  }

  unregisterNamespace(ns: string): void {
    for (const [key, entry] of [...this.providers]) {
      if (entry.ns !== ns) continue;
      for (const state of entry.owners.values()) {
        deactivate(state, this.logger);
        this.pending.delete(cellKey(entry, state.owner));
      }
      this.providers.delete(key);
    }
  }

  // --- reads ---------------------------------------------------------------

  values(): IndicatorValue[] {
    const out: IndicatorValue[] = [];
    for (const entry of this.providers.values()) {
      for (const state of entry.owners.values()) if (state.value) out.push(state.value);
    }
    return out;
  }

  /**
   * Subapp scope wins a tie: an implicit subapp's target id equals its app name,
   * and such an app renders as a single merged row from the subapp template.
   */
  get(ns: string, name: string, owner: string): IndicatorValue | undefined {
    return (
      this.providers.get(providerKey(ns, name, "subapp"))?.owners.get(owner)?.value ??
      this.providers.get(providerKey(ns, name, "app"))?.owners.get(owner)?.value
    );
  }

  onChange(cb: (values: IndicatorValue[]) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.syncCustomProviders();
    await this.activateAll();
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.deactivateAll();
    this.clearTimer("batchTimer");
    this.clearTimer("refreshTimer");
    this.expireDeadlines();
    this.refreshPending = undefined;
    // In-flight results are ignored from here on (generations bumped), so flush
    // what is already known rather than dropping it.
    this.flush();
  }

  /**
   * Re-binds to the reloaded workspace. Cached values survive by (ns, name,
   * owner), so a reload that changes nothing visible emits nothing; owners that
   * disappeared are dropped and new ones evaluate immediately.
   */
  async rebind(): Promise<void> {
    this.syncCustomProviders();
    if (!this.active) return;
    this.deactivateAll();
    await this.activateAll();
  }

  refresh(ids?: readonly TargetId[]): void {
    if (!this.active) return;
    if (ids === undefined) this.refreshPending = "all";
    else if (this.refreshPending !== "all") {
      const set = this.refreshPending ?? new Set<TargetId>();
      for (const id of ids) set.add(id);
      this.refreshPending = set;
    }
    if (this.refreshTimer !== undefined) return;
    // Coalesced: starting a profile fires one transition per target, and each
    // would otherwise re-run every pull provider on every owner.
    this.refreshTimer = unrefed(
      setTimeout(() => {
        this.refreshTimer = undefined;
        this.runRefresh();
      }, REFRESH_COALESCE_MS),
    );
  }

  // --- internals -----------------------------------------------------------

  /** Adds or replaces a provider definition without touching cached values. */
  private upsert(reg: IndicatorRegistration): ProviderEntry {
    const scope = reg.def.scope ?? "subapp";
    const key = providerKey(reg.ns, reg.name, scope);
    const update = resolveUpdate(reg.def);
    if (reg.def.value === undefined && reg.def.subscribe === undefined) {
      this.logger.warn(`${reg.ns}@${reg.name} defines neither value() nor subscribe(); it will stay empty`);
    } else if (reg.def.subscribe !== undefined && update.mode !== "event") {
      this.logger.warn(
        `${reg.ns}@${reg.name} declares update mode "${update.mode}" but defines subscribe(); ` +
          (reg.def.value === undefined ? "subscribing anyway" : "subscribe() is ignored"),
      );
    }
    const existing = this.providers.get(key);
    if (existing) {
      existing.def = reg.def;
      existing.update = update;
      existing.timeoutMs = providerTimeout(update);
      return existing;
    }
    const entry: ProviderEntry = {
      key,
      ns: reg.ns,
      name: reg.name,
      scope,
      logger: this.logger.child(`${reg.ns}@${reg.name}`),
      def: reg.def,
      update,
      timeoutMs: providerTimeout(update),
      owners: new Map(),
    };
    this.providers.set(key, entry);
    return entry;
  }

  /** Config-declared `x@` providers follow the workspace, not the plugin host. */
  private syncCustomProviders(): void {
    const wanted = customIndicators(this.deps.workspace.current().indicators);
    const keep = new Set(wanted.map((r) => providerKey(r.ns, r.name, r.def.scope ?? "subapp")));
    for (const [key, entry] of [...this.providers]) {
      if (entry.ns !== CUSTOM_NAMESPACE || keep.has(key)) continue;
      for (const state of entry.owners.values()) {
        deactivate(state, this.logger);
        this.pending.delete(cellKey(entry, state.owner));
      }
      this.providers.delete(key);
    }
    for (const reg of wanted) this.upsert(reg);
  }

  private deactivateAll(): void {
    for (const entry of this.providers.values()) {
      for (const state of entry.owners.values()) deactivate(state, this.logger);
    }
  }

  private async activateAll(): Promise<void> {
    await Promise.all([...this.providers.values()].map((entry) => this.activateEntry(entry)));
  }

  /**
   * Re-derives this provider's owners from the current workspace and starts them.
   * Resolves once the first pull of every static/event provider has landed, so a
   * snapshot taken after `start()` is populated; staggered polls are not awaited.
   */
  private async activateEntry(entry: ProviderEntry): Promise<void> {
    const owners = ownersFor(this.deps.workspace.current(), entry.scope);
    const next = new Map<string, OwnerState>();
    for (const owner of owners) {
      next.set(owner, entry.owners.get(owner) ?? { owner, running: false, queued: false, generation: 0 });
    }
    // Owners absent from the reloaded workspace fall out here, values and all —
    // including a change of theirs still sitting in the batch, which would
    // otherwise announce a cell that no longer exists to every client.
    for (const owner of entry.owners.keys()) {
      if (!next.has(owner)) this.pending.delete(cellKey(entry, owner));
    }
    entry.owners = next;

    const tasks: Array<Promise<void>> = [];
    let index = 0;
    for (const state of entry.owners.values()) tasks.push(this.activateOwner(entry, state, index++));
    await Promise.all(tasks);
  }

  private activateOwner(entry: ProviderEntry, state: OwnerState, index: number): Promise<void> {
    // A never-evaluated cell still needs an entry: a *missing* value renders as a
    // red `{ns@name!}` marker, which means "no such indicator", not "not yet". The
    // seed and the first real value land in the same batch, so nothing flickers.
    if (state.value === undefined) this.applyValue(entry, state, "");
    // One controller per activation: deactivation aborts whatever this cell is
    // waiting on, which is how a probe's child process dies with the registry.
    state.abort = new AbortController();

    if (usesSubscription(entry)) return this.activateSubscription(entry, state);
    if (entry.def.value === undefined) return Promise.resolve();

    if (entry.update.mode === "poll") {
      const intervalMs = entry.update.intervalMs;
      const step = Math.min(STAGGER_STEP_MS, intervalMs / Math.max(entry.owners.size, 1));
      state.startTimer = unrefed(
        setTimeout(
          () => {
            state.startTimer = undefined;
            this.detach(this.evaluate(entry, state));
            state.pollTimer = unrefed(
              setInterval(() => this.detach(this.evaluate(entry, state)), intervalMs),
            );
          },
          Math.floor(step * index),
        ),
      );
      return Promise.resolve();
    }

    // static and event(pull): evaluated here, then only on demand.
    return this.evaluate(entry, state);
  }

  private async activateSubscription(entry: ProviderEntry, state: OwnerState): Promise<void> {
    const subscribe = entry.def.subscribe;
    if (!subscribe) return;
    const ctx = this.contextFor(entry, state);
    if (!ctx) return;
    const gen = state.generation;

    const emit = (result: IndicatorResult): void => {
      if (state.generation !== gen) return;
      this.applyValue(entry, state, result);
    };

    // This chain runs to completion even when the race below gives up, so a
    // disposer that arrives late is still called instead of leaking its watcher.
    const settled = Promise.resolve()
      .then(() => subscribe(ctx, emit))
      .then(
        (disposer) => {
          if (typeof disposer !== "function") return;
          if (state.generation !== gen || !this.active) safeDispose(disposer, entry.logger);
          else state.disposer = disposer;
        },
        (error: unknown) => {
          this.fail(entry, state, gen, `subscribe() threw: ${errorMessage(error)}`);
        },
      );

    const outcome = await this.settle(settled, entry.timeoutMs);
    if (outcome.state === "timeout") {
      this.fail(entry, state, gen, `subscribe() did not settle within ${entry.timeoutMs}ms`);
    }
  }

  /**
   * One pull of one cell. Never rejects, never overlaps itself.
   *
   * `forced` marks an evaluation demanded by {@link refresh}: the caller knows
   * the world moved, so a run already in flight — which read the *old* world —
   * cannot stand in for it, and the cell is re-evaluated as soon as it lands.
   * Poll ticks pass `false` and are simply skipped, or a slow provider would run
   * back-to-back forever.
   */
  private async evaluate(entry: ProviderEntry, state: OwnerState, forced = false): Promise<void> {
    const value = entry.def.value;
    if (!this.active || value === undefined) return;
    if (state.running) {
      if (forced) state.queued = true;
      return;
    }
    const gen = state.generation;
    try {
      const ctx = this.contextFor(entry, state);
      if (!ctx) return;
      state.running = true;
      state.queued = false;
      const outcome = await this.settle(
        Promise.resolve().then(() => value(ctx)),
        entry.timeoutMs,
      );
      if (state.generation !== gen) return;
      if (outcome.state === "ok") this.applyValue(entry, state, outcome.value);
      else if (outcome.state === "timeout") {
        this.fail(entry, state, gen, `timed out after ${entry.timeoutMs}ms`);
      } else this.fail(entry, state, gen, errorMessage(outcome.error));
    } catch (error) {
      // Only reachable if the registry itself misbehaves; a provider's own
      // failure is already data by this point.
      this.logger.error(`${entry.ns}@${entry.name} evaluation failed: ${errorMessage(error)}`);
    } finally {
      if (state.generation === gen) {
        state.running = false;
        if (state.queued && this.active) {
          state.queued = false;
          this.detach(this.evaluate(entry, state, true));
        }
      }
    }
  }

  /** A failed provider yields an empty cell — never a stale one, never a crash. */
  private fail(entry: ProviderEntry, state: OwnerState, gen: number, reason: string): void {
    if (state.generation !== gen) return;
    entry.logger.warn(`provider failed for ${state.owner}: ${reason}`);
    this.applyValue(entry, state, "");
  }

  private applyValue(entry: ProviderEntry, state: OwnerState, result: IndicatorResult): void {
    const next = toIndicatorValue(entry, state.owner, result);
    const prev = state.value;
    if (prev && prev.value === next.value && prev.display === next.display && prev.tone === next.tone) {
      return;
    }
    state.value = next;
    this.pending.set(cellKey(entry, state.owner), next);
    if (this.batchTimer !== undefined) return;
    this.batchTimer = unrefed(
      setTimeout(() => {
        this.batchTimer = undefined;
        this.flush();
      }, CHANGE_BATCH_MS),
    );
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const values = [...this.pending.values()];
    this.pending.clear();
    for (const listener of this.listeners) {
      try {
        listener(values);
      } catch (error) {
        this.logger.warn(`indicator listener threw: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Re-pulls everything a supervisor transition could have changed. `static`
   * providers are excluded by definition — they are computed once per binding.
   */
  private runRefresh(): void {
    const pending = this.refreshPending;
    this.refreshPending = undefined;
    if (pending === undefined || !this.active) return;

    const scoped =
      pending === "all"
        ? undefined
        : { targets: pending, apps: appOwnersOf(this.deps.workspace.current(), pending) };

    for (const entry of this.providers.values()) {
      if (entry.update.mode === "static" || entry.def.value === undefined || usesSubscription(entry)) {
        continue;
      }
      for (const state of entry.owners.values()) {
        if (scoped) {
          const owners = entry.scope === "app" ? scoped.apps : scoped.targets;
          if (!owners.has(state.owner)) continue;
        }
        this.detach(this.evaluate(entry, state, true));
      }
    }
  }

  /** Fire-and-forget with a backstop: an unhandled rejection would kill the daemon. */
  private detach(work: Promise<void>): void {
    void work.catch((error: unknown) => {
      this.logger.error(`indicator task failed: ${errorMessage(error)}`);
    });
  }

  private clearTimer(field: "batchTimer" | "refreshTimer"): void {
    const timer = this[field];
    if (timer === undefined) return;
    clearTimeout(timer);
    this[field] = undefined;
  }

  /**
   * Resolves with the promise's outcome or `timeout`, whichever comes first. The
   * promise is never left unhandled — a provider that rejects after the deadline
   * would otherwise take the daemon down with an unhandled rejection.
   *
   * The deadline is registered so `stop()` can fire it early: a provider that
   * never settles would otherwise keep both a timer and a suspended evaluation
   * alive for the rest of its timeout.
   */
  private settle<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
    return new Promise<Settled<T>>((resolve) => {
      let done = false;
      const finish = (outcome: Settled<T>): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.deadlines.delete(expire);
        resolve(outcome);
      };
      const expire = (): void => finish({ state: "timeout" });
      const timer = unrefed(setTimeout(expire, ms));
      this.deadlines.add(expire);
      void promise.then(
        (value) => finish({ state: "ok", value }),
        (error: unknown) => finish({ state: "error", error }),
      );
    });
  }

  private expireDeadlines(): void {
    for (const expire of [...this.deadlines]) expire();
    this.deadlines.clear();
  }

  /** Undefined when the owner vanished from the workspace mid-flight. */
  private contextFor(entry: ProviderEntry, state: OwnerState): IndicatorContext | undefined {
    const owner = state.owner;
    const signal = state.abort?.signal;
    const ws = this.deps.workspace.current();
    const workspace = { id: ws.id, name: ws.name, rootDir: ws.rootDir, configPath: ws.configPath };
    const store = this.storeFor(entry.ns);

    if (entry.scope === "app") {
      const app = ws.apps.find((a) => a.name === owner);
      if (!app) return undefined;
      return {
        workspace,
        logger: entry.logger,
        exec: execIn(app.path, {}, signal),
        store,
        scope: "app",
        app: { name: app.name, path: app.path },
        cwd: app.path,
      };
    }

    const subapp = ws.subapps.find((s) => s.id === owner);
    if (!subapp) return undefined;
    const app = ws.apps.find((a) => a.name === subapp.appName);
    return {
      workspace,
      logger: entry.logger,
      exec: execIn(subapp.cwd, subapp.env, signal),
      store,
      scope: "subapp",
      app: { name: subapp.appName, path: app?.path ?? subapp.cwd },
      target: toTargetInfo(subapp),
      cwd: subapp.cwd,
      service: this.deps.services.state(subapp.id),
    };
  }

  private storeFor(ns: string): Map<string, unknown> {
    let store = this.stores.get(ns);
    if (!store) {
      store = new Map<string, unknown>();
      this.stores.set(ns, store);
    }
    return store;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scope is part of the key: `app@name` exists at both scopes, because the app
 * header row and the subapp row are written with the same token.
 */
function providerKey(ns: string, name: string, scope: IndicatorScope): string {
  return `${ns}@${name}#${scope}`;
}

/** Identifies one cell — a provider and the owner it was computed for. */
function cellKey(entry: ProviderEntry, owner: string): string {
  return `${entry.key}|${owner}`;
}

function ownersFor(ws: NormalizedWorkspace, scope: IndicatorScope): string[] {
  return scope === "app" ? ws.apps.map((a) => a.name) : ws.subapps.map((s) => s.id);
}

/** Apps owning any of these targets — an app row refreshes with its children. */
function appOwnersOf(ws: NormalizedWorkspace, ids: ReadonlySet<TargetId>): Set<string> {
  const out = new Set<string>();
  for (const subapp of ws.subapps) if (ids.has(subapp.id)) out.add(subapp.appName);
  return out;
}

function toTargetInfo(subapp: NormalizedSubapp): TargetInfo {
  return {
    id: subapp.id,
    appName: subapp.appName,
    name: subapp.name,
    implicit: subapp.implicit,
    cwd: subapp.cwd,
    scripts: { ...subapp.scripts },
    env: { ...subapp.env },
    dependsOn: [...subapp.dependsOn],
    hasHealth: subapp.health !== undefined,
  };
}

/**
 * `ctx.exec` defaults to the owner's cwd and merged env; callers may override.
 *
 * It also inherits the cell's abort signal, so a probe still running when the
 * registry stops (or its owner disappears) is signalled instead of outliving the
 * daemon as an orphan — nothing else would ever reap it.
 */
function execIn(
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal | undefined,
): (cmd: string, opts?: ExecOptions) => Promise<ExecResult> {
  return (cmd, opts = {}) =>
    exec(cmd, {
      ...opts,
      cwd: opts.cwd ?? cwd,
      env: { ...env, ...opts.env },
      signal: opts.signal ?? signal,
    });
}

function resolveUpdate(def: IndicatorDef): IndicatorUpdate {
  if (def.update) return def.update;
  return def.value ? { mode: "poll", intervalMs: DEFAULT_POLL_INTERVAL_MS } : { mode: "event" };
}

/** A poll provider must give up inside its own interval or ticks pile up. */
function providerTimeout(update: IndicatorUpdate): number {
  if (update.mode !== "poll") return MAX_PROVIDER_TIMEOUT_MS;
  const budget = Math.floor(update.intervalMs * 0.9);
  return Math.min(Math.max(budget, MIN_PROVIDER_TIMEOUT_MS), MAX_PROVIDER_TIMEOUT_MS);
}

/**
 * A `subscribe`-only provider is honoured whatever `update` says: a def with no
 * `value()` has nothing to poll, and silently leaving it inert would give the
 * plugin author an empty cell and no explanation (`upsert` warns about the
 * contradiction separately).
 */
function usesSubscription(entry: ProviderEntry): boolean {
  if (typeof entry.def.subscribe !== "function") return false;
  return entry.update.mode === "event" || entry.def.value === undefined;
}

function toIndicatorValue(entry: ProviderEntry, owner: string, result: IndicatorResult): IndicatorValue {
  const body =
    result === null || result === undefined
      ? { value: "" }
      : typeof result === "object"
        ? result
        : { value: String(result) };
  const out: IndicatorValue = {
    ns: entry.ns,
    name: entry.name,
    scope: entry.scope,
    owner,
    value: sanitizeIndicatorText(String(body.value ?? "")),
  };
  if (body.display !== undefined) out.display = sanitizeIndicatorText(String(body.display));
  if (body.tone !== undefined && TONES.has(body.tone)) out.tone = body.tone;
  return out;
}

/** Releases every resource one owner holds and invalidates its in-flight work. */
function deactivate(state: OwnerState, logger: Logger): void {
  state.generation += 1;
  state.running = false;
  state.queued = false;
  if (state.startTimer !== undefined) clearTimeout(state.startTimer);
  if (state.pollTimer !== undefined) clearInterval(state.pollTimer);
  state.startTimer = undefined;
  state.pollTimer = undefined;
  // Anything this cell had in flight is already being discarded; abort it so a
  // spawned child dies with it rather than running on unowned.
  state.abort?.abort();
  state.abort = undefined;
  const disposer = state.disposer;
  state.disposer = undefined;
  if (disposer) safeDispose(disposer, logger);
}

function safeDispose(disposer: () => void, logger: Logger): void {
  try {
    disposer();
  } catch (error) {
    logger.warn(`indicator disposer threw: ${errorMessage(error)}`);
  }
}

/** Indicators are decoration: they must never be the reason the daemon lives on. */
function unrefed(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref();
  return timer;
}
