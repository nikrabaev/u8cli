/**
 * The built-in `git` plugin — SPEC §7.1.
 *
 * Four app-scoped indicators (`branch`, `dirty`, `ahead`, `behind`) and two
 * read-only chores (`git:fetch`, `git:pull`). A repo is an app-level concept:
 * several subapps of a monorepo share one checkout, so everything here is keyed
 * by app, never by target.
 *
 * Three decisions shape the file:
 *
 *  - **One `git status` per app per tick.** A dashboard row asks for four
 *    values; a provider per value would fork four gits per app on every update.
 *    Instead one {@link RepoMonitor} per app runs a single
 *    `git status --porcelain=v2 --branch`, parses it once, and feeds all four
 *    cells from that parse. The monitor is refcounted in the plugin's `store`,
 *    which the indicator registry shares across every provider in the namespace.
 *  - **Event mode with a fallback poll.** An `fs.watch` on the repo's git
 *    directory catches commits, checkouts and fetches within a debounce window;
 *    a slow poll catches everything watches miss — editing a tracked file
 *    changes nothing inside `.git`, and fs.watch itself is unreliable across
 *    platforms, editors and network filesystems.
 *  - **A missing repo is a blank cell, never an error.** Non-git app dirs, a
 *    repo deleted underneath the daemon, and a machine with no `git` at all all
 *    resolve to empty values with at most one log line each.
 */
import { readFileSync, statSync, watch, type FSWatcher, type Stats } from "node:fs";
import path from "node:path";

import { definePlugin } from "../../plugin/index.js";
import type {
  CommandContext,
  IndicatorContext,
  IndicatorDef,
  IndicatorResult,
  TargetInfo,
} from "../../plugin/types.js";
import { exec } from "../../process/index.js";
import type { ExecResult } from "../../process/types.js";
import { errorMessage } from "../../util/errors.js";
import type { Logger } from "../../util/logger.js";

/** Also the reserved namespace: `{git@branch}`, `git:pull`. */
export const PLUGIN_NAME = "git";

/** The one command every indicator is derived from. */
export const GIT_STATUS_CMD = "git status --porcelain=v2 --branch";

/**
 * Quiet time after the last watch event before re-reading. A single checkout
 * rewrites `index` and `HEAD` several times in a few milliseconds; without this
 * every one of those writes would cost a `git status`.
 */
export const WATCH_DEBOUNCE_MS = 200;

/**
 * Fallback poll (SPEC §7.1). Not an optimisation to tune away: work-tree edits
 * never touch `.git`, so `{git@dirty}` would be permanently stale without it.
 */
export const FALLBACK_POLL_MS = 30_000;

/** A status read that outlives this is not worth having; the next tick is close. */
const STATUS_TIMEOUT_MS = 5_000;

/** Enough for ~10k changed files; past that the count is decorative anyway. */
const MAX_STATUS_BYTES = 2 * 1024 * 1024;

/** Longest git diagnostic carried into a task result; the run log has the rest. */
const MAX_DIAGNOSTIC_CHARS = 300;

/**
 * `GIT_OPTIONAL_LOCKS=0` stops a background status from taking `index.lock` to
 * refresh the index — a dashboard must never lose that race with the user's own
 * editor. `GIT_TERMINAL_PROMPT=0` stops a repo needing credentials from hanging
 * a fetch forever inside the daemon, where nobody can answer the prompt.
 */
const GIT_ENV: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** The indicator names, which are also the string fields of {@link RepoStatus}. */
const FIELDS = ["branch", "dirty", "ahead", "behind"] as const;

type Field = (typeof FIELDS)[number];

export interface RepoStatus {
  /** Branch name, or the short sha of a detached HEAD. */
  branch: string;
  /** Changed files, untracked included — what `{git@dirty}` shows. Empty when clean. */
  dirty: string;
  /** Commits ahead of the upstream. Empty with no upstream, and when zero. */
  ahead: string;
  behind: string;
  /**
   * Modified, staged or unmerged *tracked* files. Untracked files are excluded:
   * they show up in `dirty`, but they do not block a fast-forward pull.
   */
  trackedChanges: number;
}

const EMPTY: RepoStatus = { branch: "", dirty: "", ahead: "", behind: "", trackedChanges: 0 };

/** Porcelain v2 entry kinds: changed, renamed/copied, unmerged, untracked. */
const ENTRY_PREFIXES: ReadonlySet<string> = new Set(["1", "2", "u", "?"]);

/** Entries that count as a reason not to pull. `?` (untracked) deliberately does not. */
const TRACKED_PREFIXES: ReadonlySet<string> = new Set(["1", "2", "u"]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses `git status --porcelain=v2 --branch` output.
 *
 * The header lines carry the branch, the upstream and the ahead/behind pair;
 * every other line is one changed path. Paths containing special characters are
 * C-quoted by git, so a line is always a line and counting them is safe.
 */
export function parseGitStatus(stdout: string): RepoStatus {
  let head = "";
  let oid = "";
  let ahead = "";
  let behind = "";
  let dirty = 0;
  let trackedChanges = 0;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# ")) {
      const parts = line.split(" ");
      const key = parts[1];
      if (key === "branch.head") head = parts[2] ?? "";
      else if (key === "branch.oid") oid = parts[2] ?? "";
      else if (key === "branch.ab") {
        ahead = countOf(parts[2], "+");
        behind = countOf(parts[3], "-");
      }
      continue;
    }
    // A prefix is only an entry when a field separator follows it, so a stray
    // line (a truncation notice, a warning on stdout) is never counted.
    const prefix = line[0] ?? "";
    if (line[1] !== " " || !ENTRY_PREFIXES.has(prefix)) continue;
    dirty += 1;
    if (TRACKED_PREFIXES.has(prefix)) trackedChanges += 1;
  }

  return {
    // `(detached)` is git's placeholder for "no branch"; the sha is what a human
    // can act on. `(initial)` means a repo with no commits yet, which has a
    // branch name but nothing to abbreviate.
    branch: head === "(detached)" ? shortSha(oid) : head,
    dirty: dirty === 0 ? "" : String(dirty),
    ahead,
    behind,
    trackedChanges,
  };
}

/** `+3` → `"3"`. Zero renders empty: a row should only show what is actionable. */
function countOf(token: string | undefined, sign: string): string {
  if (token === undefined || !token.startsWith(sign)) return "";
  const n = Number.parseInt(token.slice(1), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

function shortSha(oid: string): string {
  return oid === "" || oid === "(initial)" ? "" : oid.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

export interface RepoLocation {
  /** Directory holding the `.git` entry. */
  root: string;
  /** The real git directory: `.git` itself, or what a `.git` *file* points at. */
  gitDir: string;
}

/**
 * Finds the repo governing `from`, walking upward the way git does — an app
 * pointing at `repo/services/api` is still in a repo.
 *
 * Synchronous on purpose: it is a handful of `stat` calls on a path the daemon
 * is about to shell out to anyway, and making it async would spread `await`
 * through `appliesTo`, which the plugin API defines as synchronous.
 */
export function findRepo(from: string): RepoLocation | undefined {
  let dir = path.resolve(from);
  for (;;) {
    const gitDir = resolveGitDir(path.join(dir, ".git"));
    if (gitDir !== undefined) return { root: dir, gitDir };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `.git` is a directory in a normal clone, but a *file* holding
 * `gitdir: <path>` in a linked worktree or a submodule — and that is where
 * `HEAD` and `index` actually live, so it is what has to be watched.
 */
function resolveGitDir(dot: string): string | undefined {
  const entry = statOf(dot);
  if (entry === undefined) return undefined;
  if (entry.isDirectory()) return dot;
  if (!entry.isFile()) return undefined;
  let pointer: RegExpExecArray | null;
  try {
    pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
  } catch {
    return undefined;
  }
  const target = pointer?.[1]?.trim();
  if (target === undefined || target === "") return undefined;
  const resolved = path.resolve(path.dirname(dot), target);
  // A dangling pointer — a worktree whose repo was deleted — is "not a repo".
  return statOf(resolved)?.isDirectory() === true ? resolved : undefined;
}

function statOf(target: string): Stats | undefined {
  try {
    return statSync(target);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The per-app monitor
// ---------------------------------------------------------------------------

type Emit = (value: IndicatorResult) => void;

/**
 * Owns one repo's status: the single `git status` invocation, the watcher, the
 * debounce, the fallback poll, and the fan-out to whichever of the four
 * indicators are subscribed.
 *
 * Lifetime is refcounted by subscribers. The last release tears down every
 * timer, the watcher and any status still in flight — a leaked `fs.watch` on a
 * deleted repo is a real daemon leak, not a tidiness question.
 */
class RepoMonitor {
  private readonly listeners = new Map<Field, Set<Emit>>();
  private readonly abort = new AbortController();
  private status: RepoStatus = EMPTY;
  /** False until the first read lands, so the first publish always emits. */
  private known = false;
  private watcher: FSWatcher | undefined;
  private watchedDir: string | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private refs = 0;
  private running = false;
  private queued = false;
  private disposed = false;
  /**
   * Latched when the `git` binary turns out to be missing. Per monitor rather
   * than per process: one warning per app is a diagnosis, and re-latching
   * costs nothing, while a module-level flag would leak between workspaces.
   */
  private gitMissing = false;

  constructor(
    private readonly cwd: string,
    private readonly label: string,
    private readonly logger: Logger,
    private readonly onDispose: () => void,
  ) {}

  /** Subscribes one indicator cell; the returned disposer releases its ref. */
  acquire(field: Field, emit: Emit): () => void {
    let set = this.listeners.get(field);
    if (!set) {
      set = new Set<Emit>();
      this.listeners.set(field, set);
    }
    set.add(emit);
    this.refs += 1;

    if (this.refs === 1) {
      this.arm();
      this.detach(this.refresh());
    } else if (this.known) {
      // A later subscriber is served from the parse the first one paid for.
      emit(cellOf(field, this.status));
    }

    return () => {
      this.release(field, emit);
    };
  }

  private release(field: Field, emit: Emit): void {
    // Only a *known* listener decrements: a disposer called twice must not free
    // the monitor while other cells are still reading it.
    if (this.listeners.get(field)?.delete(emit) !== true) return;
    this.refs -= 1;
    if (this.refs > 0) return;
    this.dispose();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWatching();
    this.clearPoll();
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    // Kills a `git status` still running: nothing would ever reap it otherwise.
    this.abort.abort();
    this.listeners.clear();
    this.onDispose();
  }

  private arm(): void {
    this.pollTimer = setInterval(() => {
      this.trigger();
    }, FALLBACK_POLL_MS);
    // Indicators are decoration: they must never keep the daemon alive.
    this.pollTimer.unref();
  }

  private clearPoll(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /**
   * Watches the git *directory* rather than `HEAD` and `index` themselves: git
   * replaces both by renaming a lock file over them, and a watcher bound to the
   * old inode goes deaf after the first checkout. Watching the directory also
   * reports the repo's own deletion, which is how a removed checkout clears its
   * row long before the fallback poll would.
   */
  private syncWatch(gitDir: string | undefined): void {
    if (this.watchedDir === gitDir) return;
    this.stopWatching();
    if (gitDir === undefined || this.disposed) return;
    try {
      // `persistent: false` is the watcher equivalent of an unref'd timer.
      const watcher = watch(gitDir, { persistent: false }, (_event, filename) => {
        if (isInteresting(filename)) this.trigger();
      });
      watcher.on("error", (err) => {
        // The repo moved or vanished under us. Drop the watcher; the fallback
        // poll re-establishes one if the checkout comes back.
        this.logger.debug(`git watch on ${gitDir} failed: ${errorMessage(err)}`);
        this.stopWatching();
      });
      this.watcher = watcher;
      this.watchedDir = gitDir;
    } catch (err) {
      this.logger.debug(`cannot watch ${gitDir} for ${this.label}: ${errorMessage(err)}`);
    }
  }

  private stopWatching(): void {
    const watcher = this.watcher;
    this.watcher = undefined;
    this.watchedDir = undefined;
    if (!watcher) return;
    try {
      watcher.close();
    } catch (err) {
      this.logger.debug(`closing git watch for ${this.label} threw: ${errorMessage(err)}`);
    }
  }

  /** Trailing-edge debounce: one read after a burst of writes has settled. */
  private trigger(): void {
    if (this.disposed || this.gitMissing) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.detach(this.refresh());
    }, WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  /**
   * One read of the repo, feeding all four cells. Never overlaps itself; an
   * event arriving mid-read schedules exactly one more pass, because that read
   * saw the world *before* the event and nothing else would correct it.
   */
  private async refresh(): Promise<void> {
    // `gitMissing` closes the whole machinery down: a debounce already in flight
    // when it latched must not re-arm the watcher on its way through.
    if (this.disposed || this.gitMissing) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      const repo = findRepo(this.cwd);
      this.syncWatch(repo?.gitDir);
      const next = repo === undefined ? EMPTY : await this.read();
      if (this.disposed) return;
      this.publish(next);
    } finally {
      this.running = false;
      if (this.queued && !this.disposed) {
        this.queued = false;
        this.detach(this.refresh());
      }
    }
  }

  private async read(): Promise<RepoStatus> {
    let res: ExecResult;
    try {
      res = await exec(GIT_STATUS_CMD, {
        cwd: this.cwd,
        env: GIT_ENV,
        timeoutMs: STATUS_TIMEOUT_MS,
        maxBuffer: MAX_STATUS_BYTES,
        signal: this.abort.signal,
      });
    } catch (err) {
      // `exec` only rejects when the shell itself cannot start — the app
      // directory was deleted while we were pointed at it.
      this.logger.debug(`git status could not run for ${this.label}: ${errorMessage(err)}`);
      return EMPTY;
    }

    if (res.ok) return parseGitStatus(res.stdout);

    if (isMissingBinary(res)) {
      // Disable, once. A machine without git would otherwise log every tick,
      // forever, for every app.
      this.gitMissing = true;
      this.stopWatching();
      this.clearPoll();
      this.logger.warn(`git is not available; disabling git indicators for ${this.label}`);
      return EMPTY;
    }
    if (res.signal !== null && !res.timedOut) {
      // We killed it (disposal, or a config reload re-binding the provider).
      this.logger.debug(`git status interrupted for ${this.label}`);
      return EMPTY;
    }
    // Empty, never stale: a branch name the daemon can no longer confirm is
    // worse than a blank cell.
    this.logger.warn(`git status failed for ${this.label}: ${gitDiagnostic(res) ?? `exit ${res.exitCode}`}`);
    return EMPTY;
  }

  /** Emits only the cells whose value actually moved. */
  private publish(next: RepoStatus): void {
    const prev = this.status;
    const first = !this.known;
    this.status = next;
    this.known = true;
    for (const field of FIELDS) {
      if (!first && prev[field] === next[field]) continue;
      const set = this.listeners.get(field);
      if (!set) continue;
      const cell = cellOf(field, next);
      for (const emit of [...set]) {
        try {
          emit(cell);
        } catch (err) {
          this.logger.warn(`git@${field} listener threw for ${this.label}: ${errorMessage(err)}`);
        }
      }
    }
  }

  /** Fire-and-forget with a backstop: an unhandled rejection would kill the daemon. */
  private detach(work: Promise<void>): void {
    void work.catch((err: unknown) => {
      this.logger.warn(`git refresh failed for ${this.label}: ${errorMessage(err)}`);
    });
  }
}

/**
 * Everything inside a git directory is repo state worth re-reading, except the
 * lock files git creates and removes around every write — those would double
 * the wake-ups and tell us nothing the following rename does not.
 */
function isInteresting(filename: string | null): boolean {
  return filename === null || !filename.endsWith(".lock");
}

/** Tone is a suggestion; a template's own `color()` modifier overrides it. */
function cellOf(field: Field, status: RepoStatus): IndicatorResult {
  const value = status[field];
  if (value === "") return "";
  if (field === "dirty") return { value, tone: "warn" };
  if (field === "ahead" || field === "behind") return { value, tone: "info" };
  return value;
}

/**
 * The monitor lives in the plugin's `store`, which the indicator registry shares
 * across every provider in the namespace — that sharing is what makes four
 * indicators cost one `git status`. Keyed by app path, so two apps in the same
 * checkout still get independent lifetimes.
 */
function monitorFor(ctx: IndicatorContext): RepoMonitor {
  const key = `repo:${ctx.cwd}`;
  const existing = ctx.store.get(key);
  if (existing instanceof RepoMonitor) return existing;
  const monitor = new RepoMonitor(ctx.cwd, ctx.app.name, ctx.logger, () => {
    ctx.store.delete(key);
  });
  ctx.store.set(key, monitor);
  return monitor;
}

function indicator(field: Field, description: string): IndicatorDef {
  return {
    scope: "app",
    description,
    update: { mode: "event" },
    subscribe(ctx, emit) {
      return monitorFor(ctx).acquire(field, emit);
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Only apps that are actually checkouts. `appliesTo` sees a subapp, so the walk
 * upward from its cwd is what discovers the app's repo — a monorepo subapp sits
 * several directories below the `.git` it belongs to.
 */
function inRepo(target: TargetInfo): boolean {
  return findRepo(target.cwd) !== undefined;
}

/**
 * Runs one git subcommand in the app root and mirrors its output into the run
 * log. `ctx.exec` buffers rather than streams — the SDK has no streaming exec —
 * so the lines land when the command finishes; git writes its progress to
 * stderr in bursts anyway.
 */
async function runGit(ctx: CommandContext, args: string): Promise<void> {
  ctx.log(`$ git ${args}`);
  const res = await ctx.exec(`git ${args}`, { env: { ...ctx.target.env, ...GIT_ENV } });
  for (const line of outputLines(res)) ctx.log(line);
  if (res.ok) return;
  throw new Error(failureMessage(args, res));
}

/**
 * A `--ff-only` pull against a dirty tree fails halfway through with git's own
 * "local changes would be overwritten" — after it has already fetched. Checking
 * first turns that into one clear refusal, and costs the status read we know how
 * to make. Untracked files do not count: they never block a fast-forward.
 */
async function assertPullable(ctx: CommandContext): Promise<void> {
  const res = await ctx.exec(GIT_STATUS_CMD, {
    env: { ...ctx.target.env, ...GIT_ENV },
    timeoutMs: STATUS_TIMEOUT_MS,
    maxBuffer: MAX_STATUS_BYTES,
  });
  if (!res.ok) throw new Error(failureMessage("status", res));
  const { trackedChanges } = parseGitStatus(res.stdout);
  if (trackedChanges === 0) return;
  const plural = trackedChanges === 1 ? "" : "s";
  throw new Error(
    `refusing to pull ${ctx.app.name}: ${trackedChanges} uncommitted change${plural} — commit or stash first`,
  );
}

function outputLines(res: ExecResult): string[] {
  return `${res.stdout}\n${res.stderr}`.split("\n").filter((line) => line.trim() !== "");
}

/** Fails the target with git's own words; a bare exit code explains nothing. */
function failureMessage(args: string, res: ExecResult): string {
  const detail = gitDiagnostic(res);
  if (detail !== undefined) return `git ${args} failed: ${detail}`;
  if (res.timedOut) return `git ${args} timed out`;
  if (res.signal !== null) return `git ${args} was killed by ${res.signal}`;
  return `git ${args} exited ${res.exitCode}`;
}

/**
 * The line a human needs out of git's output: its `fatal:`/`error:` lines when
 * it wrote any, else the *first* thing it said.
 *
 * First, not last: when git fails without flagging a line it states the problem
 * and then spends several lines advising a fix, so the tail is a fragment of the
 * remedy rather than the diagnosis — a bare `git pull` with no upstream ends on
 * `git branch --set-upstream-to=<remote>/<branch> main`, which explains nothing
 * as a summary. The whole message still reaches the run log.
 */
function gitDiagnostic(res: ExecResult): string | undefined {
  const lines = `${res.stderr}\n${res.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const flagged = lines.filter((line) => line.startsWith("fatal:") || line.startsWith("error:"));
  const chosen = flagged.length > 0 ? flagged : lines.slice(0, 1);
  if (chosen.length === 0) return undefined;
  return chosen.join("; ").slice(0, MAX_DIAGNOSTIC_CHARS);
}

/**
 * Every shell reports a command it cannot find as exit 127, and git itself never
 * uses that code — so 127 from `git status` means "this machine has no git",
 * which is the only failure worth switching the plugin off for. The stderr text
 * is deliberately not matched: each shell words it differently.
 */
function isMissingBinary(res: ExecResult): boolean {
  return res.exitCode === 127;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export default definePlugin({
  name: PLUGIN_NAME,
  indicators: {
    branch: indicator("branch", "Current branch, or the short sha of a detached HEAD"),
    dirty: indicator("dirty", "Number of changed files; empty when the tree is clean"),
    ahead: indicator("ahead", "Commits ahead of the upstream"),
    behind: indicator("behind", "Commits behind the upstream"),
  },
  commands: {
    fetch: {
      kind: "task",
      description: "Fetch every remote and prune deleted branches",
      // Once per app: the repo is shared, and fetching it four times because
      // four subapps were selected is exactly what `groupBy` exists to avoid.
      groupBy: "app",
      appliesTo: inRepo,
      run: (ctx) => runGit(ctx, "fetch --all --prune"),
    },
    pull: {
      kind: "task",
      description: "Fast-forward the current branch (never merges)",
      groupBy: "app",
      appliesTo: inRepo,
      async run(ctx) {
        await assertPullable(ctx);
        await runGit(ctx, "pull --ff-only");
      },
    },
  },
});
