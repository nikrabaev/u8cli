/**
 * Instances — parallel copies of part of the workspace.
 *
 * This module owns everything about an instance that is not "what its apps
 * are": the record on disk, the checkouts it was given, the ports it holds and
 * the order things happen in when one is created or destroyed. What its apps
 * are is `normalize.ts`'s business — a record is saved here, the workspace is
 * reloaded, and from then on the instance's apps are ordinary targets to
 * everything else in the daemon.
 *
 * Four rules:
 *  - **One writer, one at a time.** Every mutation runs through a single queue.
 *    Two creates arriving together would otherwise both read the same set of
 *    taken ports and both be handed the first free one.
 *  - **A failed create leaves nothing behind.** Worktrees are the expensive,
 *    visible half; any that were added are removed again before the error is
 *    reported.
 *  - **Only what u8 made is ever removed.** An adopted checkout belongs to
 *    whoever created it — another tool's worktree, a clone someone made by
 *    hand — and destroying the instance forgets it without touching it.
 *  - **Nothing here resolves to base by accident.** An instance is addressed by
 *    name, and the base instance cannot be created, destroyed or pruned.
 */
import fs from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BASE_INSTANCE,
  findInstance,
  instanceNameProblem,
  profileTargets,
  readInstanceRecords,
  resolveTargetStrings,
  serializeInstanceRecords,
  type InstanceRecord,
  type InstanceRepoRecord,
  type NormalizedRepo,
  type NormalizedWorkspace,
  type TargetId,
} from "../config/index.js";
import type { InstanceCreateParams } from "../ipc/protocol.js";
import { describeDirectory } from "../util/dirs.js";
import { errorMessage, U8Error } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";
import type { Engine, RunHandle, WorkspaceHolder } from "./contracts.js";
import { allocatePorts, type PortProbe } from "./ports.js";
import { addWorktree, deleteBranchIfUnused, locate, removeWorktree, type GitLocation } from "./worktrees.js";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface InstanceStore {
  readonly file: string;
  records(): InstanceRecord[];
  /** Replaces the whole set. Persisted before it resolves, so a reload may follow. */
  save(records: readonly InstanceRecord[]): Promise<void>;
}

export function createInstanceStore(opts: { file: string; logger?: Logger }): InstanceStore {
  const logger = opts.logger ?? nullLogger;
  const { records: initial, problem } = readInstanceRecords(opts.file);
  if (problem !== undefined) logger.warn(`instances: ${problem}`);
  let current = initial;

  return {
    file: opts.file,
    records: () => current.map(cloneRecord),
    async save(records: readonly InstanceRecord[]): Promise<void> {
      const next = records.map(cloneRecord);
      // Atomic for the reason every state file is: a daemon killed mid-write
      // must leave the previous set of instances, not half of the new one.
      await mkdir(path.dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
      try {
        await writeFile(tmp, serializeInstanceRecords(next), { encoding: "utf8", mode: 0o600 });
        await rename(tmp, opts.file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      current = next;
    },
  };
}

function cloneRecord(record: InstanceRecord): InstanceRecord {
  return {
    ...record,
    repos: Object.fromEntries(Object.entries(record.repos).map(([name, repo]) => [name, { ...repo }])),
    apps: [...record.apps],
    ports: Object.fromEntries(Object.entries(record.ports).map(([id, ports]) => [id, { ...ports }])),
    vars: { ...record.vars },
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface InstanceManagerDeps {
  workspace: WorkspaceHolder;
  store: InstanceStore;
  engine: Engine;
  logger: Logger;
  activeProfile: () => string;
  /** Re-reads the config and the records, and swaps the workspace. */
  reload(): Promise<{ ok: boolean; error?: string }>;
  /** A test seam; the real probe binds the port. */
  probe?: PortProbe;
}

export interface InstanceManager {
  /** Creates the checkouts, allocates the ports, saves the record and starts the init run. */
  create(params: InstanceCreateParams): Promise<{ name: string; run: RunHandle }>;
  /** Re-runs the init steps. */
  init(name: string): RunHandle;
  /**
   * One run: stop its services, run teardown, remove what u8 created, forget
   * the record. A failing teardown keeps the instance unless `force` is set.
   */
  destroy(name: string, opts?: { force?: boolean }): RunHandle;
  /**
   * Gives every instance app the ports the config now declares for it. Returns
   * true when a record changed, in which case the workspace must be re-read.
   */
  ensurePorts(ws: NormalizedWorkspace): Promise<boolean>;
  /**
   * Destroys adopted instances whose checkouts have all disappeared — the tool
   * that made the worktree removed it, and nothing else will ever clean up.
   */
  prune(): RunHandle[];
}

export function createInstanceManager(deps: InstanceManagerDeps): InstanceManager {
  const { store, engine, workspace } = deps;
  const log = deps.logger.child("instances");

  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `work` after everything queued before it, whether or not that succeeded. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  /** Names being destroyed; a second destroy or a prune must not race the first. */
  const leaving = new Set<string>();
  /** Checkouts seen missing on the previous prune pass, by instance. */
  const missingOnce = new Set<string>();

  const invalid = (message: string, details?: unknown): U8Error => new U8Error("INSTANCE_INVALID", message, details);

  const takenPorts = (ws: NormalizedWorkspace, records: readonly InstanceRecord[]): Set<number> => {
    const taken = new Set<number>();
    for (const app of ws.apps) {
      if (app.instance !== BASE_INSTANCE) continue;
      for (const port of Object.values(app.ports)) taken.add(port);
    }
    for (const record of records) {
      for (const ports of Object.values(record.ports)) for (const port of Object.values(ports)) taken.add(port);
    }
    return taken;
  };

  const baseRepos = (ws: NormalizedWorkspace): NormalizedRepo[] => ws.repos.filter((r) => r.instance === BASE_INSTANCE);

  // --- create ---------------------------------------------------------------

  /**
   * Which directory each repo of the workspace would have inside the given
   * checkouts. One adopted worktree covers every repo that lives in the same
   * git repository, each at the prefix it has in the base checkout.
   */
  const adoptedCheckouts = async (
    ws: NormalizedWorkspace,
    params: InstanceCreateParams,
    locations: Map<string, GitLocation | undefined>,
  ): Promise<Map<string, InstanceRepoRecord>> => {
    const out = new Map<string, InstanceRepoRecord>();

    for (const dir of params.adopt ?? []) {
      const where = await locate(dir);
      if (where === undefined) throw invalid(`cannot adopt ${dir}: it is not a git checkout`, { dir });
      let matched = false;
      for (const repo of baseRepos(ws)) {
        const base = locations.get(repo.name);
        if (base === undefined || base.commonDir !== where.commonDir) continue;
        matched = true;
        // The base checkout itself is not a second copy of anything.
        if (base.top === where.top) {
          throw invalid(`cannot adopt ${dir}: it is the base checkout of "${repo.name}"`, { dir });
        }
        out.set(repo.name, { path: path.join(where.top, base.prefix), owned: false });
      }
      if (!matched) {
        throw invalid(`cannot adopt ${dir}: it is not a worktree of any repo in this workspace`, { dir });
      }
    }

    for (const [repoName, dir] of Object.entries(params.paths ?? {})) {
      if (!baseRepos(ws).some((r) => r.name === repoName)) {
        throw new U8Error("UNKNOWN_TARGET", `unknown repo "${repoName}" in paths`, { repo: repoName });
      }
      const problem = path.isAbsolute(dir) ? describeDirectory(dir) : `not an absolute path: ${dir}`;
      if (problem !== undefined) throw invalid(`cannot use ${dir} for "${repoName}": ${problem}`, { dir });
      out.set(repoName, { path: fs.realpathSync(dir), owned: false });
    }
    return out;
  };

  const create = (params: InstanceCreateParams): Promise<{ name: string; run: RunHandle }> =>
    serial(async () => {
      const ws = workspace.current();
      const name = params.name;
      const problem = instanceNameProblem(name);
      if (problem !== undefined) throw invalid(problem, { name });
      if (store.records().some((r) => r.name === name)) {
        throw new U8Error("INSTANCE_EXISTS", `instance "${name}" already exists`, { name });
      }

      const locations = new Map<string, GitLocation | undefined>();
      await Promise.all(
        baseRepos(ws).map(async (repo) => {
          locations.set(repo.name, await locate(repo.path));
        }),
      );
      const adopted = await adoptedCheckouts(ws, params, locations);

      // What it runs: what was asked for; failing that, whatever the adopted
      // checkouts hold; failing that, the profile the user is looking at.
      const requested = params.targets ?? [];
      const selected: TargetId[] =
        requested.length > 0
          ? resolveTargetStrings(ws, requested)
          : adopted.size > 0
            ? ws.apps.filter((a) => a.instance === BASE_INSTANCE && adopted.has(a.repoName)).map((a) => a.id)
            : profileTargets(ws, deps.activeProfile());
      if (selected.length === 0) throw invalid(`instance "${name}" would have no apps`, { name });

      const repoNames = [
        ...new Set(selected.map((id) => ws.apps.find((a) => a.id === id)?.repoName).filter(isString)),
      ];
      const members = baseRepos(ws).filter((r) => repoNames.includes(r.name));

      const branch = params.branch ?? name;
      const repos: Record<string, InstanceRepoRecord> = {};
      const created: Array<{ repoTop: string; dir: string; branch: string | undefined }> = [];
      try {
        // One worktree per git repository, shared by every repo that lives in it.
        const worktrees = new Map<string, { dir: string; createdBranch: boolean }>();
        for (const repo of members) {
          const given = adopted.get(repo.name);
          if (given !== undefined) {
            repos[repo.name] = given;
            continue;
          }
          const where = locations.get(repo.name);
          if (where === undefined) {
            throw invalid(
              `"${repo.name}" (${repo.path}) is not a git checkout, so there is nothing to make a worktree of — ` +
                `give the instance an existing directory for it instead`,
              { repo: repo.name },
            );
          }
          let made = worktrees.get(where.commonDir);
          if (made === undefined) {
            const alone =
              where.prefix === "" && members.filter((m) => locations.get(m.name)?.commonDir === where.commonDir).length === 1;
            const dir = uniqueDir(
              path.join(ws.instancesDir, name),
              alone ? repo.name : path.basename(where.top),
              [...worktrees.values()].map((w) => w.dir),
            );
            const { createdBranch } = await addWorktree({ repoTop: where.top, dir, branch, from: params.from });
            created.push({ repoTop: where.top, dir, branch: createdBranch ? branch : undefined });
            made = { dir, createdBranch };
            worktrees.set(where.commonDir, made);
          }
          repos[repo.name] = {
            path: path.join(made.dir, where.prefix),
            owned: true,
            branch,
            worktree: made.dir,
            ...(made.createdBranch ? { createdBranch: true } : {}),
          };
        }

        const wanted = selected.flatMap((id) =>
          Object.keys(ws.apps.find((a) => a.id === id)?.ports ?? {}).map((port) => ({ id, port })),
        );
        const numbers = await allocatePorts({
          range: ws.portRange,
          taken: takenPorts(ws, store.records()),
          count: wanted.length,
          probe: deps.probe,
        });
        const ports: InstanceRecord["ports"] = {};
        wanted.forEach(({ id, port }, index) => {
          const number = numbers[index];
          if (number !== undefined) (ports[id] ??= {})[port] = number;
        });

        // Every app of its repos is stored as "no list": a repo that grows an
        // app later then grows it here too, without the record being rewritten.
        const everything = ws.apps.filter((a) => a.instance === BASE_INSTANCE && repoNames.includes(a.repoName));
        const record: InstanceRecord = {
          name,
          createdAt: Date.now(),
          repos,
          apps: everything.length === selected.length ? [] : selected,
          ports,
          vars: { ...params.vars },
        };

        const before = store.records();
        await store.save([...before, record]);
        const reloaded = await deps.reload();
        if (!reloaded.ok || !findInstance(workspace.current(), name)) {
          await store.save(before);
          await deps.reload();
          throw invalid(
            `instance "${name}" could not be added: ${reloaded.error ?? "the workspace did not pick it up"}`,
            { name },
          );
        }
      } catch (err) {
        for (const { repoTop, dir, branch: madeBranch } of created.reverse()) {
          await removeWorktree(repoTop, dir).catch((cleanup: unknown) => {
            log.warn(`could not remove the worktree at ${dir} after a failed create: ${errorMessage(cleanup)}`);
          });
          // Made a moment ago and never used: leaving it would make the retry
          // check out an existing branch instead of creating one from `from`.
          if (madeBranch !== undefined) await deleteBranchIfUnused(repoTop, madeBranch);
        }
        throw err;
      }

      log.info(`created instance "${name}"`, { repos: Object.keys(repos), apps: selected });
      return { name, run: init(name) };
    });

  // --- init -----------------------------------------------------------------

  const markInitialized = (name: string): Promise<void> =>
    serial(async () => {
      const records = store.records();
      const record = records.find((r) => r.name === name);
      if (!record) return;
      record.initializedAt = Date.now();
      await store.save(records);
      await deps.reload();
    });

  function init(name: string): RunHandle {
    if (!findInstance(workspace.current(), name)) {
      throw new U8Error("UNKNOWN_INSTANCE", `unknown instance "${name}"`, { instance: name });
    }
    return engine.runLifecycle("init", name, {
      finalize: async (ok) => {
        // Base has no record to mark: it is always considered ready.
        if (ok && name !== BASE_INSTANCE) await markInitialized(name);
      },
    });
  }

  // --- destroy --------------------------------------------------------------

  const forget = (name: string): Promise<void> =>
    serial(async () => {
      const records = store.records();
      const record = records.find((r) => r.name === name);
      if (!record) return;

      const ws = workspace.current();
      const failures: string[] = [];
      const removed = new Set<string>();
      for (const [repoName, checkout] of Object.entries(record.repos)) {
        if (!checkout.owned || checkout.worktree === undefined || removed.has(checkout.worktree)) continue;
        removed.add(checkout.worktree);
        const base = baseRepos(ws).find((r) => r.name === repoName);
        try {
          // A repo the config has dropped has no base checkout left to ask git
          // through; the directory is still ours, so it is removed directly.
          if (base !== undefined) {
            await removeWorktree(base.path, checkout.worktree);
            if (checkout.createdBranch === true && checkout.branch !== undefined) {
              const gone = await deleteBranchIfUnused(base.path, checkout.branch);
              if (!gone) log.info(`kept branch "${checkout.branch}" of ${repoName}: it has commits of its own`);
            }
          } else {
            await rm(checkout.worktree, { recursive: true, force: true });
          }
        } catch (err) {
          failures.push(errorMessage(err));
        }
      }
      if (failures.length > 0) throw new U8Error("WORKTREE_FAILED", failures.join("; "), { name });

      // The directory that held its worktrees, once nothing is left in it.
      await fs.promises.rmdir(path.join(ws.instancesDir, name)).catch(() => undefined);
      await store.save(records.filter((r) => r.name !== name));
      await deps.reload();
      log.info(`destroyed instance "${name}"`);
    });

  function destroy(name: string, opts: { force?: boolean } = {}): RunHandle {
    if (name === BASE_INSTANCE) throw invalid(`"${BASE_INSTANCE}" is the workspace itself and cannot be destroyed`);
    if (!store.records().some((r) => r.name === name)) {
      throw new U8Error("UNKNOWN_INSTANCE", `unknown instance "${name}"`, { instance: name });
    }
    if (leaving.has(name)) throw invalid(`instance "${name}" is already being destroyed`, { name });
    leaving.add(name);

    const run = engine.runLifecycle("teardown", name, {
      stopFirst: true,
      finalize: async (ok) => {
        if (!ok && opts.force !== true) {
          throw new U8Error(
            "PROCESS_FAILED",
            `teardown failed, so instance "${name}" was kept — fix the step and destroy it again, or force it`,
            { name },
          );
        }
        await forget(name);
      },
    });
    const release = (): void => {
      leaving.delete(name);
      missingOnce.delete(name);
    };
    run.done.then(release, release);
    return run;
  }

  // --- upkeep ---------------------------------------------------------------

  const ensurePorts = (ws: NormalizedWorkspace): Promise<boolean> =>
    serial(async () => {
      const wanted: Array<{ instance: string; id: TargetId; port: string }> = [];
      for (const app of ws.apps) {
        if (app.instance === BASE_INSTANCE) continue;
        for (const [port, number] of Object.entries(app.ports)) {
          if (number === 0) wanted.push({ instance: app.instance, id: app.baseId, port });
        }
      }
      if (wanted.length === 0) return false;

      const records = store.records();
      const numbers = await allocatePorts({
        range: ws.portRange,
        taken: takenPorts(ws, records),
        count: wanted.length,
        probe: deps.probe,
      });
      wanted.forEach(({ instance, id, port }, index) => {
        const record = records.find((r) => r.name === instance);
        const number = numbers[index];
        if (!record || number === undefined) return;
        (record.ports[id] ??= {})[port] = number;
        log.info(`allocated port ${number} to "${port}" of ${id}@${instance}`);
      });
      await store.save(records);
      return true;
    });

  function prune(): RunHandle[] {
    const out: RunHandle[] = [];
    for (const record of store.records()) {
      const checkouts = Object.values(record.repos);
      // Only instances made entirely of adopted checkouts: a worktree u8
      // created is removed by `u8 instance destroy`, and its directory being
      // absent is as likely an unmounted disk as a finished task.
      const abandoned =
        checkouts.length > 0 &&
        checkouts.every((c) => !c.owned && describeDirectory(c.path) !== undefined) &&
        !leaving.has(record.name);
      if (!abandoned) {
        missingOnce.delete(record.name);
        continue;
      }
      // Twice in a row, so a checkout that is being moved or re-created is
      // not mistaken for one that is gone.
      if (!missingOnce.has(record.name)) {
        missingOnce.add(record.name);
        continue;
      }
      log.info(`instance "${record.name}": every checkout is gone — stopping it and freeing its ports`);
      try {
        out.push(destroy(record.name, { force: true }));
      } catch (err) {
        log.warn(`pruning instance "${record.name}" failed: ${errorMessage(err)}`);
      }
    }
    return out;
  }

  return { create, init, destroy, ensurePorts, prune };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** `<parent>/<name>`, suffixed when two repositories would otherwise share a directory. */
function uniqueDir(parent: string, name: string, taken: readonly string[]): string {
  let candidate = path.join(parent, name);
  for (let n = 2; taken.includes(candidate); n++) candidate = path.join(parent, `${name}-${n}`);
  return candidate;
}
