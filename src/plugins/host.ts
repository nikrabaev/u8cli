/**
 * The plugin host — SPEC §2.8, §6, PLAN Phase 8.
 *
 * It loads every plugin the workspace asks for and exposes what they
 * contributed through the four methods the daemon's collaborators already code
 * against: indicators for the registry, commands and hooks for the engine, and
 * a readiness verdict for `dependsOn` gating.
 *
 * Five rules shape it:
 *  - **Isolation-lite.** A plugin that throws at import, at validation or in
 *    `setup()` is disabled and recorded with its error. The daemon serves the
 *    rest of the workspace as if it had never been listed; `list()` is the only
 *    place the failure shows up, and the daemon turns it into `plugin.error`.
 *  - **Nothing a plugin starts outlives it.** Every context the host builds
 *    carries an abort signal it owns, so a command a plugin shelled out to is
 *    reaped when the plugin is torn down, disabled, or misses its deadline —
 *    `teardown()` takes no context and could not reach that child itself.
 *  - **Nothing a plugin does may hang the daemon.** Loading, tearing down and
 *    every readiness call run under a deadline. A `readiness()` that never
 *    settles resolves `"n/a"`, which is the same answer as "I have no opinion" —
 *    so one bad plugin cannot wedge a profile start forever.
 *  - **One store per plugin.** The registry and the engine each keep their own
 *    per-namespace scratch map; the host substitutes its own on every
 *    definition it hands out, so a plugin sees one Map everywhere (see
 *    `withStore`).
 *  - **Load order is the contract.** Built-ins first, then `plugins` in config
 *    order — that order decides which readiness verdict wins and the sequence
 *    hooks run in.
 */
import type { NormalizedWorkspace } from "../config/types.js";
import type {
  BoundCommand,
  BoundHook,
  IndicatorRegistration,
  PluginHost,
  WorkspaceHolder,
} from "../daemon/contracts.js";
import { toAppInfo, toTargetInfo } from "../engine/index.js";
import type { ServiceState, SnapshotPlugin } from "../ipc/protocol.js";
import type {
  HookDef,
  IndicatorDef,
  PluginCommandDef,
  PluginDefinition,
  ReadinessContext,
  ReadinessVerdict,
  TargetInfo,
} from "../plugin/types.js";
import { errorMessage, U8Error } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { HealthPluginOptions } from "./builtin/health.js";
import { pluginBaseContext, withStore } from "./context.js";
import {
  builtinAvailable,
  importPluginModule,
  pluginSources,
  type BuiltinName,
  type PluginSource,
} from "./load.js";
import { declaredNameOf, validatePluginDefinition } from "./validate.js";

/**
 * Deadline for one `readiness()` call. Generous next to the engine's 100 ms
 * poll — the point is to survive a plugin that never answers, not to police how
 * fast it does.
 */
export const READINESS_TIMEOUT_MS = 2_000;

/** Deadline for importing plus setting up one plugin, and for its teardown. */
export const LOAD_TIMEOUT_MS = 10_000;

/**
 * Named export a built-in may offer alongside its default one: a factory the
 * host calls with {@link PluginHostDeps.builtinOptions}. It is how a built-in
 * receives daemon state the plugin SDK has no channel for — the SDK is the
 * contract for *third-party* plugins, and widening it so `health` can see
 * process lifecycle would hand every plugin the supervisor.
 *
 * The default export stays a working, unwired instance, so importing the module
 * directly (or loading it as a plain plugin) behaves exactly as before.
 */
const BUILTIN_FACTORY = "createPlugin";

/**
 * Per-built-in construction options, passed to that built-in's
 * {@link BUILTIN_FACTORY} export. Only built-ins get these: they ship inside
 * u8cli, so the daemon knows what each one accepts.
 */
export type BuiltinPluginOptions = {
  [K in BuiltinName]?: K extends "health" ? HealthPluginOptions : object;
};

export interface PluginHostDeps {
  workspace: WorkspaceHolder;
  logger: Logger;
  /** Reports a disabled plugin so the daemon can push `plugin.error`. */
  onError?(plugin: string, error: string): void;
  /** Live daemon state for the built-ins that can use it; see {@link BUILTIN_FACTORY}. */
  builtinOptions?: BuiltinPluginOptions;
  readinessTimeoutMs?: number;
  loadTimeoutMs?: number;
}

/** The host as the daemon owns it: a {@link PluginHost} with a lifecycle. */
export interface LoadablePluginHost extends PluginHost {
  /** Imports and sets up every plugin. Idempotent; never rejects. */
  load(): Promise<void>;
  /** Tears every loaded plugin down, tolerating throws. Idempotent. */
  dispose(): Promise<void>;
}

/** A plugin that loaded: its definition plus everything derived from it once. */
interface LoadedPlugin {
  name: string;
  spec: string;
  def: PluginDefinition;
  store: Map<string, unknown>;
  logger: Logger;
  /**
   * Cancels whatever the plugin spawned through the contexts the host built for
   * it. `teardown()` takes no context, so a plugin that shelled out from
   * `setup()` has nothing else that could ever reap that child.
   */
  abort: AbortController;
  indicators: IndicatorRegistration[];
  commands: BoundCommand[];
  /** Keyed by command name, or `"*"`. */
  hooks: Map<string, HookDef>;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function createPluginHost(deps: PluginHostDeps): LoadablePluginHost {
  const log = deps.logger.child("plugins");
  const readinessTimeoutMs = deps.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  const loadTimeoutMs = deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS;

  const loaded: LoadedPlugin[] = [];
  const records: SnapshotPlugin[] = [];
  /**
   * Keyed by plugin name rather than by load, so a plugin re-loaded by a future
   * config reload picks its own scratch space back up.
   */
  const stores = new Map<string, Map<string, unknown>>();

  let loadPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;

  const storeFor = (name: string): Map<string, unknown> => {
    let store = stores.get(name);
    if (!store) {
      store = new Map<string, unknown>();
      stores.set(name, store);
    }
    return store;
  };

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * What to validate as the plugin definition: whatever the module exported,
   * unless it is a built-in offering a {@link BUILTIN_FACTORY} — then the
   * definition is what that factory builds from the daemon's options. A throw
   * here is a load failure like any other, so the plugin is disabled rather
   * than taking the daemon with it.
   */
  const instantiate = (mod: unknown, source: PluginSource): unknown => {
    const builtin = source.builtin;
    if (builtin === undefined || typeof mod !== "object" || mod === null) return mod;
    const factory = (mod as Record<string, unknown>)[BUILTIN_FACTORY];
    if (typeof factory !== "function") return mod;
    return (factory as (opts: object) => unknown)(deps.builtinOptions?.[builtin] ?? {});
  };

  /**
   * Imports, validates and sets up one plugin. Everything that can go wrong
   * throws; the caller turns that into a disabled plugin.
   */
  const build = async (
    source: PluginSource,
    ws: NormalizedWorkspace,
    abort: AbortController,
  ): Promise<LoadedPlugin> => {
    const mod = await importPluginModule(source, ws.rootDir);
    const def = validatePluginDefinition(instantiate(mod, source), source.spec);

    const clash = loaded.find((p) => p.name === def.name);
    if (clash) {
      throw new U8Error(
        "PLUGIN_LOAD",
        `plugin "${source.spec}": name "${def.name}" is already taken by "${clash.spec}" — ` +
          `a plugin name is a namespace (${def.name}:command, {${def.name}@indicator}) and must be unique`,
        { spec: source.spec, plugin: def.name },
      );
    }

    const store = storeFor(def.name);
    const logger = deps.logger.child(def.name);

    if (def.setup) {
      try {
        // Called on the definition so a plugin written as an object literal can
        // still reach its own members through `this`.
        await def.setup.call(def, {
          ...pluginBaseContext({ workspace: ws, logger, store, cwd: ws.rootDir, signal: abort.signal }),
          targets: ws.subapps.map(toTargetInfo),
          apps: ws.apps.map(toAppInfo),
        });
      } catch (err) {
        // Re-thrown as a PLUGIN_LOAD so the record can still be attributed to
        // the name the plugin declared, rather than to its file.
        throw new U8Error("PLUGIN_LOAD", `plugin "${source.spec}": setup() failed: ${errorMessage(err)}`, {
          spec: source.spec,
          plugin: def.name,
        });
      }
    }

    return {
      name: def.name,
      spec: source.spec,
      def,
      store,
      logger,
      abort,
      indicators: Object.entries(def.indicators ?? {}).map(([name, indicator]) => ({
        ns: def.name,
        name,
        def: bindIndicator(indicator, store),
      })),
      commands: Object.entries(def.commands ?? {}).map(([name, command]) => ({
        plugin: def.name,
        name: `${def.name}:${name}`,
        def: bindCommand(command, store),
      })),
      hooks: new Map(
        Object.entries(def.hooks ?? {}).map(([command, hook]) => [command, bindHook(hook, store)]),
      ),
    };
  };

  const disable = (source: PluginSource, err: unknown): void => {
    const name = declaredNameOf(err) ?? fallbackName(source);
    const error = errorMessage(err);
    records.push({ name, spec: source.spec, ok: false, error });
    log.warn(`plugin "${source.spec}" is disabled: ${error}`);
    try {
      deps.onError?.(name, error);
    } catch (cbError) {
      log.warn(`plugin error listener threw: ${errorMessage(cbError)}`);
    }
  };

  const loadAll = async (): Promise<void> => {
    const ws = deps.workspace.current();
    // Sequential on purpose: load order decides hook order and readiness
    // precedence, and a plugin's setup may legitimately depend on an earlier
    // one having claimed its namespace.
    for (const source of pluginSources(ws)) {
      if (source.builtin !== undefined && !builtinAvailable(source.builtin)) {
        log.warn(`built-in plugin "${source.builtin}" is not part of this u8cli install; skipping it`);
        continue;
      }
      const abort = new AbortController();
      const work = build(source, ws, abort);
      const outcome = await deadline(work, loadTimeoutMs, `loading "${source.spec}"`);
      if (!outcome.ok) {
        // The plugin is disabled, so nothing will ever hold what it started.
        abort.abort();
        // A build that lands *after* its deadline is the nastier case: it ran
        // setup() against a plugin nobody is tracking, so it is torn straight
        // back down rather than left with timers and watchers no one can stop.
        void work
          .then(
            (late) => teardownOne(late),
            () => undefined,
          )
          .catch((err: unknown) => {
            log.warn(`late teardown of "${source.spec}" threw: ${errorMessage(err)}`);
          });
        disable(source, outcome.error);
        continue;
      }
      loaded.push(outcome.value);
      records.push({ name: outcome.value.name, spec: source.spec, ok: true });
      log.debug(`loaded plugin "${outcome.value.name}" from ${source.spec}`, {
        indicators: outcome.value.indicators.length,
        commands: outcome.value.commands.length,
        hooks: [...outcome.value.hooks.keys()],
      });
    }
  };

  const doLoad = async (): Promise<void> => {
    try {
      await loadAll();
    } catch (err) {
      // Only reachable if the host itself misbehaves — a plugin's own failure is
      // already data by this point. Either way the daemon keeps running.
      log.error(`loading plugins failed: ${errorMessage(err)}`);
    }
  };

  /**
   * Releases one plugin: its own `teardown()` first — it may want a last `exec`
   * through a context it captured — and then the abort that reaps anything it
   * left running regardless of whether that teardown cooperated.
   */
  const teardownOne = async (plugin: LoadedPlugin): Promise<void> => {
    const teardown = plugin.def.teardown;
    if (teardown) {
      const outcome = await deadline(
        Promise.resolve().then(() => teardown.call(plugin.def)),
        loadTimeoutMs,
        `tearing down "${plugin.name}"`,
      );
      if (!outcome.ok) {
        log.warn(`teardown of plugin "${plugin.name}" failed: ${errorMessage(outcome.error)}`);
      }
    }
    plugin.abort.abort();
  };

  const doDispose = async (): Promise<void> => {
    // Reverse load order: a plugin set up later may depend on an earlier one.
    for (const plugin of loaded.splice(0).reverse()) await teardownOne(plugin);
  };

  // -------------------------------------------------------------------------
  // Surface
  // -------------------------------------------------------------------------

  return {
    load(): Promise<void> {
      if (disposePromise !== undefined) return Promise.resolve();
      loadPromise ??= doLoad();
      return loadPromise;
    },

    dispose(): Promise<void> {
      disposePromise ??= (async () => {
        // A shutdown can land while `load()` is still running: waiting for it is
        // what keeps a plugin from being set up *after* the teardown pass, with
        // nothing left to ever release it. Each plugin's load is deadlined, so
        // this cannot wait forever.
        await loadPromise;
        await doDispose();
      })();
      return disposePromise;
    },

    indicators(): IndicatorRegistration[] {
      return loaded.flatMap((p) => p.indicators);
    },

    commands(): BoundCommand[] {
      return loaded.flatMap((p) => p.commands);
    },

    /**
     * A plugin's own bindings stay adjacent: its exact-command hook, then its
     * `"*"` hook, then the next plugin's. The engine runs config-declared shell
     * hooks before any of these (SPEC §2.6).
     */
    hooksFor(command: string): BoundHook[] {
      const out: BoundHook[] = [];
      for (const plugin of loaded) {
        const exact = plugin.hooks.get(command);
        if (exact) out.push({ plugin: plugin.name, def: exact });
        const wildcard = command === "*" ? undefined : plugin.hooks.get("*");
        if (wildcard) out.push({ plugin: plugin.name, def: wildcard });
      }
      return out;
    },

    /**
     * First opinion wins, in load order. A plugin that throws, or that never
     * answers, is treated as having none — the alternative is a `dependsOn`
     * gate that never opens.
     */
    async readiness(target: TargetInfo, service: ServiceState): Promise<ReadinessVerdict> {
      const ws = deps.workspace.current();
      for (const plugin of loaded) {
        const readiness = plugin.def.readiness;
        if (!readiness) continue;
        const abort = new AbortController();
        const ctx: ReadinessContext = {
          ...pluginBaseContext({
            workspace: ws,
            logger: plugin.logger,
            store: plugin.store,
            cwd: target.cwd,
            env: target.env,
            signal: abort.signal,
          }),
          target,
          service,
        };
        const outcome = await deadline(
          Promise.resolve().then(() => readiness.call(plugin.def, ctx)),
          readinessTimeoutMs,
          `readiness of "${plugin.name}" for ${target.id}`,
        );
        // Readiness is a question, not a task: whatever it shelled out to is
        // finished the moment it answers — and if it timed out instead, the
        // engine will ask again in 100 ms, so leaving the last probe running
        // would pile up a child per poll for the whole readiness window.
        abort.abort();
        if (!outcome.ok) {
          plugin.logger.warn(`readiness for ${target.id} failed: ${errorMessage(outcome.error)}`);
          continue;
        }
        if (outcome.value === "ready" || outcome.value === "pending") return outcome.value;
      }
      return "n/a";
    },

    list(): SnapshotPlugin[] {
      return records.map((r) => ({ ...r }));
    },
  };
}

// ---------------------------------------------------------------------------
// Binding: the host's store, injected into every context the plugin sees
// ---------------------------------------------------------------------------

function bindIndicator(indicator: IndicatorDef, store: Map<string, unknown>): IndicatorDef {
  const bound: IndicatorDef = {
    scope: indicator.scope,
    description: indicator.description,
    update: indicator.update,
  };
  // Presence is meaningful to the registry — a def with no `value` is a
  // subscription, not a poll — so an absent callback must stay absent.
  const value = indicator.value;
  if (value) bound.value = (ctx) => value.call(indicator, withStore(ctx, store));
  const subscribe = indicator.subscribe;
  if (subscribe) bound.subscribe = (ctx, emit) => subscribe.call(indicator, withStore(ctx, store), emit);
  return bound;
}

function bindCommand(command: PluginCommandDef, store: Map<string, unknown>): PluginCommandDef {
  const bound: PluginCommandDef = {
    kind: command.kind,
    description: command.description,
    groupBy: command.groupBy,
    run: (ctx) => command.run(withStore(ctx, store)),
  };
  const appliesTo = command.appliesTo;
  if (appliesTo) bound.appliesTo = (target) => appliesTo.call(command, target);
  return bound;
}

function bindHook(hook: HookDef, store: Map<string, unknown>): HookDef {
  const bound: HookDef = {};
  const pre = hook.pre;
  if (pre) bound.pre = (ctx) => pre.call(hook, withStore(ctx, store));
  const post = hook.post;
  if (post) bound.post = (ctx) => post.call(hook, withStore(ctx, store));
  return bound;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Settles with the promise's outcome or a timeout, whichever lands first.
 *
 * The promise is always handled, so a plugin that rejects after the deadline
 * cannot take the daemon down with an unhandled rejection, and the timer is
 * unref'd — waiting on a plugin is never a reason for the process to stay up.
 */
function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let done = false;
    const finish = (outcome: Settled<T>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: new U8Error("PLUGIN_LOAD", `${what} timed out after ${ms}ms`) });
    }, ms);
    timer.unref();
    work.then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, error }),
    );
  });
}

/** The best name for a plugin that failed before it could declare one. */
function fallbackName(source: PluginSource): string {
  if (source.kind === "builtin") return source.builtin ?? source.spec;
  if (source.kind === "package") return source.spec;
  const base = source.spec.split("/").pop() ?? source.spec;
  return base.replace(/\.[cm]?[jt]s$/, "") || source.spec;
}
