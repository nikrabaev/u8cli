/**
 * Instances — parallel copies of part of the workspace.
 *
 * This module owns everything about an instance that is not "what its apps
 * are": the record on disk, the checkouts it was given, the ports it holds and
 * the order things happen in when one is created, grown, shrunk or destroyed.
 * What its apps are is `normalize.ts`'s business — a record is saved here, the
 * workspace is reloaded, and from then on the instance's apps are ordinary
 * targets to everything else in the daemon.
 *
 * Six rules:
 *  - **One writer, one at a time.** Every mutation runs through a single queue.
 *    Two creates arriving together would otherwise both read the same set of
 *    taken ports and both be handed the first free one.
 *  - **A failed create or add leaves nothing behind.** Worktrees are the
 *    expensive, visible half; any that were added are removed again before the
 *    error is reported.
 *  - **Only what u8 made is ever removed.** An adopted checkout belongs to
 *    whoever created it — another tool's worktree, a clone someone made by
 *    hand — and destroying the instance forgets it without touching it.
 *  - **Nothing here resolves to base by accident.** An instance is addressed by
 *    name, and the base instance cannot be created, edited, destroyed or pruned.
 *  - **An app leaving is not its checkout leaving.** Destroying an instance is
 *    a decision about everything in it; taking one app out is not. The
 *    checkout its last app ran from stays the instance's until it is given up
 *    by name, and even then a worktree with uncommitted work in it is only
 *    removed when that was said too.
 *  - **One membership change per instance at a time, and none during an
 *    init.** Which of a repo's own steps an add or a remove runs is decided
 *    from who is a member when it starts; a second edit overlapping it would
 *    decide from a set that is about to change underneath it, and an init run
 *    that began before an app arrived would vouch for an app it never touched.
 */
import fs from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BASE_INSTANCE,
  findApp,
  findInstance,
  instanceNameProblem,
  profileTargets,
  qualify,
  qualifyTarget,
  readInstanceRecords,
  resolveTargetStrings,
  serializeInstanceRecords,
  splitQualified,
  type InstanceRecord,
  type InstanceRepoRecord,
  type NormalizedRepo,
  type NormalizedWorkspace,
  type TargetId,
} from "../config/index.js";
import type { InstanceAddParams, InstanceCreateParams, InstanceRemoveParams } from "../ipc/protocol.js";
import { describeDirectory } from "../util/dirs.js";
import { errorMessage, U8Error } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";
import type { Engine, RunHandle, WorkspaceHolder } from "./contracts.js";
import { allocatePorts, type PortProbe } from "./ports.js";
import {
  addWorktree,
  deleteBranchIfUnused,
  locate,
  removeWorktree,
  uncommittedChanges,
  type GitLocation,
} from "./worktrees.js";

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
   * Grows an instance: a checkout for each repo it has none of, ports for the
   * new apps, the record, and the init run of what was added — theirs only.
   */
  add(params: InstanceAddParams): Promise<{ name: string; added: TargetId[]; run: RunHandle }>;
  /**
   * One run: stop the apps, run their teardown, free their ports and drop them
   * from the record. A failing teardown keeps them unless `force` is set. The
   * checkout of a repo left with no apps stays unless `prune` gives it up.
   */
  remove(params: InstanceRemoveParams): Promise<{ name: string; removed: TargetId[]; run: RunHandle }>;
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
  /**
   * Runs in flight that an add or a remove must not overlap, by instance:
   * another add or remove, or an init of the whole instance. A count, because
   * two inits of one instance may run at once and each ends on its own.
   */
  const holds = new Map<string, number>();
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

  // --- membership -----------------------------------------------------------

  /** Base ids of the apps an instance runs, in config order. */
  const membersOf = (ws: NormalizedWorkspace, name: string): TargetId[] =>
    ws.apps.filter((a) => a.instance === name).map((a) => a.baseId);

  /** The repo a base app belongs to, by its name in `u8.jsonc`. */
  const repoOf = (ws: NormalizedWorkspace, baseId: TargetId): string | undefined => findApp(ws, baseId)?.repoName;

  const reposOf = (ws: NormalizedWorkspace, baseIds: readonly TargetId[]): string[] => [
    ...new Set(baseIds.map((id) => repoOf(ws, id)).filter(isString)),
  ];

  /**
   * Base app ids a target string names, for changing what an instance holds.
   * Membership is written the way the config writes apps — `api`,
   * `platform.shell` — so a name carrying an instance is refused rather than
   * read as some other copy's.
   */
  const namedApps = (ws: NormalizedWorkspace, spec: string): TargetId[] => {
    const { name: bare, instance } = splitQualified(qualifyTarget(spec));
    if (instance !== BASE_INSTANCE) {
      throw new U8Error(
        "UNKNOWN_TARGET",
        `"${spec}" names one instance's copy — write the app the way the config does: "${bare}"`,
        { spec },
      );
    }
    return resolveTargetStrings(ws, [spec]);
  };

  /**
   * The record a membership change acts on. Base has none to change: what it
   * runs is what `u8.jsonc` declares and the active profile selects.
   */
  const editable = (name: string): InstanceRecord => {
    if (name === BASE_INSTANCE) {
      throw invalid(
        `"${BASE_INSTANCE}" is the workspace itself — its apps are the ones u8.jsonc declares, and cannot be added or removed`,
      );
    }
    const record = store.records().find((r) => r.name === name);
    if (!record) throw new U8Error("UNKNOWN_INSTANCE", `unknown instance "${name}"`, { instance: name });
    if (leaving.has(name)) throw invalid(`instance "${name}" is being destroyed`, { name });
    if ((holds.get(name) ?? 0) > 0) {
      throw invalid(
        `instance "${name}" is still busy with an earlier init, add or remove — wait for that run to finish`,
        { name },
      );
    }
    return record;
  };

  /**
   * Holds an instance against membership changes for as long as the run that
   * `start` returns is going.
   */
  const held = (name: string, start: () => RunHandle): RunHandle => {
    holds.set(name, (holds.get(name) ?? 0) + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = (holds.get(name) ?? 1) - 1;
      if (left > 0) holds.set(name, left);
      else holds.delete(name);
    };
    try {
      const run = start();
      run.done.then(release, release);
      return run;
    } catch (err) {
      release();
      throw err;
    }
  };

  /**
   * How a set of apps is stored. Every app of the record's repos is "no list",
   * for the reason create stores it that way; anything less is spelled out, in
   * config order.
   */
  const storedApps = (
    ws: NormalizedWorkspace,
    repos: Record<string, InstanceRepoRecord>,
    apps: readonly TargetId[],
  ): TargetId[] => {
    const base = ws.apps.filter((a) => a.instance === BASE_INSTANCE);
    const everything = base.filter((a) => repos[a.repoName] !== undefined).map((a) => a.id);
    const wanted = new Set(apps);
    if (wanted.size === everything.length && everything.every((id) => wanted.has(id))) return [];
    // "No list" is the only thing an empty one can mean, and here it would
    // bring back every app that was just taken out.
    if (wanted.size === 0) throw new U8Error("INTERNAL", "an instance cannot be stored with no apps");
    const known = base.map((a) => a.id).filter((id) => wanted.has(id));
    // A name the config does not have at the moment keeps its place: an edit
    // in progress there must not be what makes the record forget an app.
    return [...known, ...[...wanted].filter((id) => !known.includes(id))];
  };

  const listOf = (ids: readonly string[]): string => ids.map((id) => `"${id}"`).join(", ");

  // --- checkouts ------------------------------------------------------------

  /** A worktree this call added, kept so a failure further on can take it back out. */
  interface MadeWorktree {
    repoTop: string;
    dir: string;
    /** Set when the branch was created along with it. */
    branch: string | undefined;
  }

  /** A worktree that one or more repos of an instance live in. */
  interface SharedWorktree {
    /** Its root. */
    dir: string;
    owned: boolean;
    branch?: string;
    createdBranch?: boolean;
  }

  /**
   * The worktrees an instance's checkouts already live in, by git repository.
   * A repo that joins later takes its place in its sibling's worktree: asking
   * git for a second one on the same branch is refused.
   */
  const worktreesOf = async (record: InstanceRecord): Promise<Map<string, SharedWorktree>> => {
    const out = new Map<string, SharedWorktree>();
    for (const checkout of Object.values(record.repos)) {
      const where = await locate(checkout.worktree ?? checkout.path);
      if (where === undefined || out.has(where.commonDir)) continue;
      out.set(
        where.commonDir,
        checkout.owned && checkout.worktree !== undefined
          ? { dir: checkout.worktree, owned: true, branch: checkout.branch, createdBranch: checkout.createdBranch }
          : { dir: where.top, owned: false },
      );
    }
    return out;
  };

  /**
   * A checkout for each of `members`: the directory it was given; failing
   * that, its place in a worktree the instance already has of the same git
   * repository; failing that, a new worktree. Every worktree added is pushed
   * onto `created` as it is made, so the caller can take them back out when a
   * later step fails.
   */
  const checkoutsFor = async (args: {
    ws: NormalizedWorkspace;
    name: string;
    members: readonly NormalizedRepo[];
    locations: Map<string, GitLocation | undefined>;
    given: Map<string, InstanceRepoRecord>;
    existing: Map<string, SharedWorktree>;
    /** Worktree directories already spoken for, beyond the ones made here. */
    taken: readonly string[];
    branch: string;
    from: string | undefined;
    created: MadeWorktree[];
  }): Promise<Record<string, InstanceRepoRecord>> => {
    const { ws, name, members, locations, given, taken, branch, from, created } = args;
    const repos: Record<string, InstanceRepoRecord> = {};
    // One worktree per git repository, shared by every repo that lives in it.
    const worktrees = new Map(args.existing);
    for (const repo of members) {
      const adopted = given.get(repo.name);
      if (adopted !== undefined) {
        repos[repo.name] = adopted;
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
      let shared = worktrees.get(where.commonDir);
      if (shared === undefined) {
        const alone =
          where.prefix === "" && members.filter((m) => locations.get(m.name)?.commonDir === where.commonDir).length === 1;
        const dir = uniqueDir(path.join(ws.instancesDir, name), alone ? repo.name : path.basename(where.top), [
          ...taken,
          ...[...worktrees.values()].map((w) => w.dir),
        ]);
        const { createdBranch } = await addWorktree({ repoTop: where.top, dir, branch, from });
        created.push({ repoTop: where.top, dir, branch: createdBranch ? branch : undefined });
        shared = { dir, owned: true, branch, ...(createdBranch ? { createdBranch: true } : {}) };
        worktrees.set(where.commonDir, shared);
      }
      repos[repo.name] = shared.owned
        ? {
            path: path.join(shared.dir, where.prefix),
            owned: true,
            ...(shared.branch === undefined ? {} : { branch: shared.branch }),
            worktree: shared.dir,
            ...(shared.createdBranch === true ? { createdBranch: true } : {}),
          }
        : { path: path.join(shared.dir, where.prefix), owned: false };
    }
    return repos;
  };

  /** Removes the worktrees a failed create or add had already made, newest first. */
  const takeBack = async (created: readonly MadeWorktree[], what: string): Promise<void> => {
    for (const { repoTop, dir, branch } of [...created].reverse()) {
      await removeWorktree(repoTop, dir).catch((cleanup: unknown) => {
        log.warn(`could not remove the worktree at ${dir} after a failed ${what}: ${errorMessage(cleanup)}`);
      });
      // Made a moment ago and never used: leaving it would make the retry
      // check out an existing branch instead of creating one from `from`.
      if (branch !== undefined) await deleteBranchIfUnused(repoTop, branch);
    }
  };

  // --- create ---------------------------------------------------------------

  /**
   * Which directory each repo of the workspace would have inside the given
   * checkouts. One adopted worktree covers every repo that lives in the same
   * git repository, each at the prefix it has in the base checkout.
   */
  const adoptedCheckouts = async (
    ws: NormalizedWorkspace,
    params: Pick<InstanceCreateParams, "adopt" | "paths">,
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

      let repos: Record<string, InstanceRepoRecord> = {};
      const created: MadeWorktree[] = [];
      try {
        repos = await checkoutsFor({
          ws,
          name,
          members,
          locations,
          given: adopted,
          existing: new Map(),
          taken: [],
          branch: params.branch ?? name,
          from: params.from,
          created,
        });

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
        await takeBack(created, "create");
        throw err;
      }

      log.info(`created instance "${name}"`, { repos: Object.keys(repos), apps: selected });
      return { name, run: init(name) };
    });

  // --- add ------------------------------------------------------------------

  const add = (params: InstanceAddParams): Promise<{ name: string; added: TargetId[]; run: RunHandle }> =>
    serial(async () => {
      const ws = workspace.current();
      const name = params.name;
      const record = editable(name);

      const members = membersOf(ws, name);
      const adding: TargetId[] = [];
      for (const spec of params.targets) {
        const fresh = namedApps(ws, spec).filter((id) => !members.includes(id));
        if (fresh.length === 0) {
          throw invalid(`"${spec}" is already part of instance "${name}"`, { name, target: spec });
        }
        for (const id of fresh) if (!adding.includes(id)) adding.push(id);
      }
      if (adding.length === 0) {
        throw invalid(`nothing to add to instance "${name}" — name the apps or repos it should gain`, { name });
      }

      const repoNames = reposOf(ws, adding);
      // A repo's own steps run wherever the instance had no app of it — which is
      // as true of a checkout kept after its last app left as of a new one.
      const arriving = repoNames.filter((repo) => !members.some((id) => repoOf(ws, id) === repo));
      const lacking = baseRepos(ws).filter((r) => repoNames.includes(r.name) && record.repos[r.name] === undefined);

      for (const repo of repoNames) {
        const held = record.repos[repo];
        const problem = held === undefined ? undefined : describeDirectory(held.path);
        if (problem !== undefined) {
          throw invalid(
            `instance "${name}" holds a checkout of "${repo}" that cannot be used (${problem}) — ` +
              `give it up first: u8 -i ${name} instance remove ${repo} --prune`,
            { name, repo },
          );
        }
      }

      const locations = new Map<string, GitLocation | undefined>();
      await Promise.all(
        baseRepos(ws).map(async (repo) => {
          locations.set(repo.name, await locate(repo.path));
        }),
      );

      // A directory inside a worktree u8 made for this instance is not somebody
      // else's to adopt: recorded as that, it would be a checkout u8 must never
      // remove sitting in one it removes. Left alone, the repo is put there anyway.
      const own = Object.values(record.repos)
        .map((c) => c.worktree)
        .filter(isString);
      const notOwn = (checkout: InstanceRepoRecord | undefined, dir: string): void => {
        if (checkout === undefined || !own.some((worktree) => isWithin(checkout.path, worktree))) return;
        throw invalid(
          `${dir} is inside a worktree instance "${name}" already has — add without it, and the repo is put there`,
          { dir },
        );
      };

      // Every directory given has to be for something being added: one that is
      // quietly ignored reads as one that took effect.
      const given = new Map<string, InstanceRepoRecord>();
      for (const dir of params.adopt ?? []) {
        const covered = await adoptedCheckouts(ws, { adopt: [dir] }, locations);
        for (const checkout of covered.values()) notOwn(checkout, dir);
        const used = lacking.filter((r) => covered.has(r.name));
        if (used.length === 0) {
          throw invalid(
            `cannot adopt ${dir}: it holds none of the repos instance "${name}" needs a checkout of for ${listOf(adding)}`,
            { dir },
          );
        }
        for (const repo of used) {
          const checkout = covered.get(repo.name);
          if (checkout !== undefined) given.set(repo.name, checkout);
        }
      }
      for (const [repoName, dir] of Object.entries(params.paths ?? {})) {
        const checkout = (await adoptedCheckouts(ws, { paths: { [repoName]: dir } }, locations)).get(repoName);
        const held = record.repos[repoName];
        if (held !== undefined) {
          throw invalid(`instance "${name}" already has a checkout of "${repoName}" (${held.path})`, { repo: repoName });
        }
        if (checkout === undefined || !lacking.some((r) => r.name === repoName)) {
          throw invalid(`"${repoName}" is not a repo of anything being added, so ${dir} has nothing to be the checkout of`, {
            repo: repoName,
          });
        }
        notOwn(checkout, dir);
        given.set(repoName, checkout);
      }

      // Where create would have put them: on the branch the instance's own
      // worktrees are on, which is its name unless it was created with another.
      const branches = new Set(
        Object.values(record.repos)
          .map((c) => (c.owned ? c.branch : undefined))
          .filter(isString),
      );
      const [shared] = [...branches];
      const branch = params.branch ?? (branches.size === 1 && shared !== undefined ? shared : name);

      const wasInitialized = record.initializedAt !== undefined;
      let repos: Record<string, InstanceRepoRecord> = {};
      const created: MadeWorktree[] = [];
      try {
        repos = await checkoutsFor({
          ws,
          name,
          members: lacking,
          locations,
          given,
          existing: await worktreesOf(record),
          taken: Object.values(record.repos)
            .map((c) => c.worktree)
            .filter(isString),
          branch,
          from: params.from,
          created,
        });
        if (created.length === 0 && (params.branch !== undefined || params.from !== undefined)) {
          throw invalid(
            `a branch was chosen, but nothing being added to instance "${name}" needs a new worktree: ` +
              `${listOf(adding)} ${adding.length === 1 ? "lives" : "live"} in a checkout it already has or was given`,
            { name },
          );
        }

        const wanted = adding.flatMap((id) =>
          Object.keys(findApp(ws, id)?.ports ?? {})
            .filter((port) => record.ports[id]?.[port] === undefined)
            .map((port) => ({ id, port })),
        );
        const before = store.records();
        const numbers = await allocatePorts({
          range: ws.portRange,
          taken: takenPorts(ws, before),
          count: wanted.length,
          probe: deps.probe,
        });
        wanted.forEach(({ id, port }, index) => {
          const number = numbers[index];
          if (number !== undefined) (record.ports[id] ??= {})[port] = number;
        });

        Object.assign(record.repos, repos);
        record.apps = storedApps(ws, record.repos, [...(record.apps.length > 0 ? record.apps : members), ...adding]);
        // Not ready again until the new apps' steps have run: `u8 up` reads
        // this to decide whether a copy may be started as it is.
        delete record.initializedAt;

        // A destroy that began while the worktrees were being made has already
        // decided what it tears down, and these apps are not among them.
        if (leaving.has(name)) throw invalid(`instance "${name}" is being destroyed`, { name });
        await store.save(before.map((r) => (r.name === name ? record : r)));
        const reloaded = await deps.reload();
        const now = workspace.current();
        if (!reloaded.ok || !adding.every((id) => findApp(now, qualify(id, name)) !== undefined)) {
          await store.save(before);
          await deps.reload();
          throw invalid(
            `${listOf(adding)} could not be added to instance "${name}": ` +
              (reloaded.error ?? "the workspace did not pick the change up"),
            { name },
          );
        }
      } catch (err) {
        await takeBack(created, "add");
        throw err;
      }

      const added = adding.map((id) => qualify(id, name));
      const run = held(name, () =>
        engine.runLifecycle("init", name, {
          only: { apps: added, repos: arriving.map((repo) => qualify(repo, name)) },
          finalize: async (ok) => {
            // A failure leaves it as a create whose init failed is left: not
            // ready, and saying so until its init steps have been through.
            if (ok && wasInitialized) await markInitialized(name);
          },
        }),
      );
      log.info(`added to instance "${name}"`, { repos: Object.keys(repos), apps: adding });
      return { name, added, run };
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
    // Held for its length: the run covers the apps the instance has now, and
    // what it reports at the end is taken as true of the whole instance.
    return held(name, () =>
      engine.runLifecycle("init", name, {
        finalize: async (ok) => {
          // Base has no record to mark: it is always considered ready.
          if (ok && name !== BASE_INSTANCE) await markInitialized(name);
        },
      }),
    );
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

  // --- remove ---------------------------------------------------------------

  /** The checkouts a removal gives up. */
  interface PrunePlan {
    /** Base names of the repos whose checkout leaves the record. */
    repos: string[];
    /** The worktrees u8 created that go with them, and a checkout to ask git through. */
    worktrees: Array<{ dir: string; via: string; branch: string | undefined }>;
  }

  /**
   * What the `named` repos give up once only `staying` is left. Each leaves the
   * record. A worktree is the unit on disk: it goes when nothing the instance
   * still runs lives in it, and every repo that shared it then leaves with it.
   */
  const prunePlan = (
    ws: NormalizedWorkspace,
    record: InstanceRecord,
    staying: readonly TargetId[],
    named: readonly string[],
  ): PrunePlan => {
    const inUse = new Set(reposOf(ws, staying));
    const plan: PrunePlan = { repos: [], worktrees: [] };
    for (const repoName of named) {
      const checkout = record.repos[repoName];
      if (checkout === undefined || inUse.has(repoName) || plan.repos.includes(repoName)) continue;
      if (!checkout.owned || checkout.worktree === undefined) {
        // Somebody else's: it leaves the record and stays on the disk.
        plan.repos.push(repoName);
        continue;
      }
      // By where it is, not by what its entry says: a checkout recorded as
      // adopted can still sit inside this worktree, and goes when it does.
      const root = checkout.worktree;
      const sharing = Object.entries(record.repos)
        .filter(([, other]) => other.worktree === root || isWithin(other.path, root))
        .map(([other]) => other);
      // Still the home of an app that runs, so the worktree stays. The repo's
      // place in it needs no record: an app of it that comes back is put into
      // the worktree its sibling has, the same way it was the first time.
      if (sharing.some((other) => inUse.has(other))) {
        plan.repos.push(repoName);
        continue;
      }
      const base = baseRepos(ws).find((r) => r.name === repoName);
      if (base === undefined) continue;
      for (const other of sharing) if (!plan.repos.includes(other)) plan.repos.push(other);
      plan.worktrees.push({
        dir: checkout.worktree,
        via: base.path,
        branch: checkout.createdBranch === true ? checkout.branch : undefined,
      });
    }
    return plan;
  };

  /** `README.md, src/a.ts and 3 more`, from `git status --porcelain` lines. */
  const changedPaths = (lines: readonly string[]): string => {
    const shown = lines.slice(0, 3).map((line) => line.slice(3));
    const rest = lines.length - shown.length;
    return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
  };

  /**
   * The record's half of a removal: the apps' ports and their place in the
   * list, and the checkouts being given up. Must run inside the queue.
   */
  const applyRemoval = async (
    name: string,
    going: readonly TargetId[],
    giveUp: readonly string[] | undefined,
    discard: boolean,
  ): Promise<void> => {
    const records = store.records();
    const record = records.find((r) => r.name === name);
    // Destroyed while its apps were being torn down: there is nothing left to edit.
    if (!record) return;
    const ws = workspace.current();

    const staying = (record.apps.length > 0 ? record.apps : membersOf(ws, name)).filter((id) => !going.includes(id));
    if (going.length > 0 && staying.length === 0) {
      throw invalid(`nothing else is left in instance "${name}" — destroy it instead: u8 instance destroy ${name}`, {
        name,
      });
    }
    for (const id of going) delete record.ports[id];

    const failures: string[] = [];
    if (giveUp !== undefined) {
      const plan = prunePlan(ws, record, staying, giveUp);
      const kept = new Set<string>();
      for (const worktree of plan.worktrees) {
        try {
          // Not forced unless that was asked for: the check that it is clean
          // was made before the teardown ran, and git gets the last word.
          await removeWorktree(worktree.via, worktree.dir, { force: discard });
          if (worktree.branch !== undefined && !(await deleteBranchIfUnused(worktree.via, worktree.branch))) {
            log.info(`kept branch "${worktree.branch}": it has commits of its own`);
          }
        } catch (err) {
          failures.push(errorMessage(err));
          for (const [repoName, checkout] of Object.entries(record.repos)) {
            if (checkout.worktree === worktree.dir || isWithin(checkout.path, worktree.dir)) kept.add(repoName);
          }
        }
      }
      for (const repoName of plan.repos) if (!kept.has(repoName)) delete record.repos[repoName];
      // The directory that held its worktrees, once nothing is left in it.
      await fs.promises.rmdir(path.join(ws.instancesDir, name)).catch(() => undefined);
    }

    if (staying.length > 0) record.apps = storedApps(ws, record.repos, staying);
    await store.save(records);
    const reloaded = await deps.reload();
    if (going.length > 0) log.info(`removed from instance "${name}"`, { apps: [...going] });
    if (failures.length > 0) {
      throw new U8Error(
        "WORKTREE_FAILED",
        (going.length > 0 ? `${listOf(going)} left instance "${name}", but its checkout is still held: ` : "") +
          failures.join("; "),
        { name },
      );
    }
    if (!reloaded.ok) {
      // The record is right and the workspace in service is the last one that
      // loaded: said, because until it loads again every reader sees the old set.
      throw invalid(
        `the change to instance "${name}" is saved, but shows only once the workspace loads again: ${reloaded.error ?? "the reload failed"}`,
        { name },
      );
    }
  };

  const remove = (params: InstanceRemoveParams): Promise<{ name: string; removed: TargetId[]; run: RunHandle }> =>
    serial(async () => {
      const ws = workspace.current();
      const name = params.name;
      const record = editable(name);
      const prune = params.prune === true;
      const discard = params.discard === true;
      if (discard && !prune) {
        throw invalid("discarding uncommitted changes only applies to a checkout that is being given up (--prune)");
      }

      const members = membersOf(ws, name);
      const going: TargetId[] = [];
      /** Repos named for the checkout an earlier remove left in place. */
      const leftover: string[] = [];
      for (const spec of params.targets) {
        const named = namedApps(ws, spec);
        const mine = named.filter((id) => members.includes(id));
        if (mine.length > 0) {
          for (const id of mine) if (!going.includes(id)) going.push(id);
          continue;
        }
        const held = reposOf(ws, named).filter(
          (repo) => record.repos[repo] !== undefined && !members.some((id) => repoOf(ws, id) === repo),
        );
        if (held.length === 0 || !prune) {
          throw new U8Error(
            "UNKNOWN_TARGET",
            `"${spec}" is not part of instance "${name}"` +
              (held.length > 0 ? " — only its checkout is still held, and giving that up takes --prune" : ""),
            { spec, instance: name },
          );
        }
        for (const repo of held) if (!leftover.includes(repo)) leftover.push(repo);
      }
      if (going.length === 0 && leftover.length === 0) {
        throw invalid(`nothing to remove from instance "${name}" — name the apps or repos it should lose`, { name });
      }

      const staying = members.filter((id) => !going.includes(id));
      if (going.length > 0 && staying.length === 0) {
        throw invalid(
          `removing ${listOf(going)} would leave instance "${name}" with no apps — ` +
            `to be rid of the instance, destroy it: u8 instance destroy ${name}`,
          { name },
        );
      }

      // A repo's own teardown runs when the last of its apps goes, whatever
      // happens to its checkout: it undoes what the repo's init set up.
      const emptied = reposOf(ws, going).filter((repo) => !staying.some((id) => repoOf(ws, id) === repo));
      const giveUp = prune ? [...new Set([...emptied, ...leftover])] : undefined;

      if (giveUp !== undefined && !discard) {
        // Asked before anything is stopped: finding out once the teardown has
        // run would leave the app gone and the question still open.
        for (const worktree of prunePlan(ws, record, staying, giveUp).worktrees) {
          const changes = await uncommittedChanges(worktree.dir);
          if (changes?.length === 0) continue;
          // A directory that is already gone has nothing in it to lose. One
          // that is there but that git cannot read is not known to be clean.
          if (changes === undefined && describeDirectory(worktree.dir) !== undefined) continue;
          throw new U8Error(
            "WORKTREE_FAILED",
            (changes === undefined
              ? `git could not say whether the worktree at ${worktree.dir} has uncommitted changes`
              : `the worktree at ${worktree.dir} has uncommitted changes (${changedPaths(changes)})`) +
              ", so nothing was stopped or removed — " +
              "commit or stash them, leave the checkout in place by dropping --prune, or throw them away with --discard",
            { dir: worktree.dir, changes: changes?.length },
          );
        }
      }

      const removed = going.map((id) => qualify(id, name));
      if (going.length === 0) {
        // Only checkouts, and nothing runs from those: there is no step to wait
        // for, so it happens here and the run is the empty one that says so.
        await applyRemoval(name, [], giveUp, discard);
        return { name, removed, run: engine.runLifecycle("teardown", name, { only: { apps: [], repos: [] } }) };
      }

      const run = held(name, () =>
        engine.runLifecycle("teardown", name, {
          stopFirst: true,
          only: { apps: removed, repos: emptied.map((repo) => qualify(repo, name)) },
          finalize: async (ok) => {
            if (!ok && params.force !== true) {
              throw new U8Error(
                "PROCESS_FAILED",
                `teardown failed, so ${listOf(going)} stayed in instance "${name}" — fix the step and remove again, or force it`,
                { name },
              );
            }
            await serial(() => applyRemoval(name, going, giveUp, discard));
          },
        }),
      );
      return { name, removed, run };
    });

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

  return { create, init, add, remove, destroy, ensurePorts, prune };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** True when `candidate` is `root` or somewhere beneath it. */
function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `<parent>/<name>`, suffixed when two repositories would otherwise share a directory. */
function uniqueDir(parent: string, name: string, taken: readonly string[]): string {
  let candidate = path.join(parent, name);
  for (let n = 2; taken.includes(candidate); n++) candidate = path.join(parent, `${name}-${n}`);
  return candidate;
}
