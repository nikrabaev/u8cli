/**
 * The git half of an instance: finding out where a directory sits in its
 * repository, and adding or removing the worktrees u8 itself creates.
 *
 * Git is called with an argv, never through a shell: every argument here is a
 * path or a branch name that came from a config file or a command line, and
 * none of them should ever be something a shell gets to interpret.
 *
 * A repo in `u8.jsonc` is a directory, not necessarily a repository root — a
 * workspace may list three directories of one monorepo as three repos. That is
 * why everything here speaks in terms of a repository's top level plus a
 * prefix: one worktree serves every repo that lives in the same repository.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { errorMessage, U8Error } from "../util/errors.js";

const execFileAsync = promisify(execFile);

/** Ceiling on one git call. `worktree add` checks out a whole tree, so it is generous. */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Keeps git from stopping to ask: a credential prompt or an editor would hang
 * a daemon that has no terminal to answer on.
 */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } as const;

export interface GitLocation {
  /** Root of the working tree `dir` is in. */
  top: string;
  /**
   * The repository's shared `.git` directory. Equal for a repository's main
   * checkout and every worktree of it, which is what identifies them as one.
   */
  commonDir: string;
  /** `dir` relative to {@link top}; empty at the root. */
  prefix: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/** What git itself said, without the "Command failed: git …" wrapper node adds. */
function gitFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim().replace(/^fatal: /, "");
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return "git is not installed or not on PATH";
  return errorMessage(err);
}

/** Symlink-resolved, because git reports real paths and the two must compare equal. */
function real(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** `undefined` when `dir` is missing or is not inside a git working tree. */
export async function locate(dir: string): Promise<GitLocation | undefined> {
  try {
    const out = await git(dir, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]);
    const [top, commonDir] = out.split("\n").map((line) => line.trim());
    if (!top || !commonDir) return undefined;
    const prefix = path.relative(real(top), real(dir));
    // A `dir` that resolves outside its own top level is not something to guess about.
    if (prefix.startsWith("..")) return undefined;
    return { top: real(top), commonDir: real(commonDir), prefix };
  } catch {
    return undefined;
  }
}

async function branchExists(repoTop: string, branch: string): Promise<boolean> {
  try {
    await git(repoTop, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export interface AddWorktreeOptions {
  /** Any checkout of the repository; git finds the rest. */
  repoTop: string;
  /** Where the worktree goes. Must not exist, or must be an empty directory. */
  dir: string;
  branch: string;
  /** Start point when `branch` has to be created; the base checkout's HEAD by default. */
  from?: string;
}

/**
 * Adds a worktree on `branch`, creating the branch when it does not exist yet.
 *
 * An existing branch is checked out as it is — that is how a task picked up on
 * another machine, or a branch a teammate pushed, gets a worktree. Git refuses
 * a branch that is already checked out elsewhere, and its message for that says
 * where, so it is passed on rather than paraphrased.
 */
export async function addWorktree(opts: AddWorktreeOptions): Promise<{ createdBranch: boolean }> {
  const existing = await branchExists(opts.repoTop, opts.branch);
  const args = existing
    ? ["worktree", "add", opts.dir, opts.branch]
    : ["worktree", "add", "-b", opts.branch, opts.dir, ...(opts.from === undefined ? [] : [opts.from])];
  try {
    await fs.promises.mkdir(path.dirname(opts.dir), { recursive: true });
    await git(opts.repoTop, args);
    return { createdBranch: !existing };
  } catch (err) {
    throw new U8Error(
      "WORKTREE_FAILED",
      `could not create a worktree of ${opts.repoTop} at ${opts.dir}: ${gitFailure(err)}`,
      { repo: opts.repoTop, dir: opts.dir, branch: opts.branch },
    );
  }
}

/**
 * Deletes a branch u8 created, if and only if git considers it merged — which
 * for a branch nobody committed to is always, and for one somebody did is
 * never. `-d`, not `-D`: the refusal *is* the safety check, so it is left to
 * git and a refusal is simply the answer "keep it".
 */
export async function deleteBranchIfUnused(repoTop: string, branch: string): Promise<boolean> {
  try {
    await git(repoTop, ["branch", "-d", branch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Paths in the worktree at `dir` that exist nowhere else: modified, staged and
 * untracked files, one `git status --porcelain` line each. Ignored files are
 * left out on purpose — they are what an install or a build put there, and
 * the next init puts them back.
 *
 * `undefined` when git cannot say (the directory is gone, or is not a
 * checkout), which a caller must not read as "clean".
 */
export async function uncommittedChanges(dir: string): Promise<string[] | undefined> {
  try {
    const out = await git(dir, ["status", "--porcelain"]);
    return out.split("\n").filter((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

export interface RemoveWorktreeOptions {
  /**
   * `false` leaves the decision to git, which refuses a worktree holding
   * modified or untracked files — for when only part of an instance is going
   * and nobody has said its uncommitted work may go with it.
   */
  force?: boolean;
}

/**
 * Removes a worktree u8 created. `--force` by default because the instance is
 * going away with whatever is uncommitted in it — the caller has already
 * decided that — and a directory git no longer recognises is removed by hand,
 * so a worktree someone half-deleted does not make an instance impossible to
 * destroy. Without force nothing is ever deleted by hand: git's refusal is the
 * answer, and it is passed on.
 *
 * The branch is not this function's business: it may hold the only copy of
 * someone's commits (see {@link deleteBranchIfUnused}).
 */
export async function removeWorktree(repoTop: string, dir: string, opts: RemoveWorktreeOptions = {}): Promise<void> {
  const force = opts.force !== false;
  try {
    await git(repoTop, ["worktree", "remove", ...(force ? ["--force"] : []), dir]);
    return;
  } catch (err) {
    if (!fs.existsSync(dir)) {
      await git(repoTop, ["worktree", "prune"]).catch(() => undefined);
      return;
    }
    if (!force) {
      throw new U8Error("WORKTREE_FAILED", `could not remove the worktree at ${dir}: ${gitFailure(err)}`, {
        repo: repoTop,
        dir,
      });
    }
    const location = await locate(dir);
    // Only ever delete by hand what is recognisably a worktree of this
    // repository, or not a git checkout at all: never another repository.
    const mine = await locate(repoTop);
    if (location !== undefined && (mine === undefined || location.commonDir !== mine.commonDir)) {
      throw new U8Error("WORKTREE_FAILED", `could not remove the worktree at ${dir}: ${gitFailure(err)}`, {
        repo: repoTop,
        dir,
      });
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    await git(repoTop, ["worktree", "prune"]).catch(() => undefined);
  }
}
