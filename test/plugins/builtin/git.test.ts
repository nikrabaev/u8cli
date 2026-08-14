import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawWorkspaceConfig } from "../../../src/config/index.js";
import type { IndicatorRegistry } from "../../../src/daemon/contracts.js";
import { createIndicatorRegistry } from "../../../src/indicators/index.js";
import type { IndicatorValue } from "../../../src/ipc/protocol.js";
import type {
  IndicatorContext,
  IndicatorDef,
  IndicatorResult,
  PluginCommandDef,
} from "../../../src/plugin/types.js";
import gitPlugin, { FALLBACK_POLL_MS, WATCH_DEBOUNCE_MS, findRepo } from "../../../src/plugins/builtin/git.js";
import { exec as execCommand } from "../../../src/process/index.js";
import {
  cleanupHarnesses,
  createHarness,
  resultFor,
  settled,
  statesByTarget,
  type Harness,
} from "../../engine/helpers.js";
import {
  cleanupRoots,
  delay,
  fakeServices,
  holderOf,
  makeWorkspace,
  recordingLogger,
  tempRoot,
  waitFor,
  type RecordingLogger,
} from "../../indicators/helpers.js";

/**
 * Resolved once, before any test starts playing with `$PATH` — every repo these
 * tests build is a real one, driven by the real binary.
 */
const GIT = resolveGit();

function resolveGit(): string {
  const found = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  const bin = found.stdout.trim();
  if (found.status !== 0 || bin === "") throw new Error("these tests require a real git binary");
  return bin;
}

/** Test-side git, always the real binary, never the spy. */
function git(cwd: string, ...args: string[]): string {
  const res = spawnSync(GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim();
}

function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "u8@example.test");
  git(dir, "config", "user.name", "u8 test");
  return dir;
}

function commit(dir: string, file: string, text: string, message = `write ${file}`): void {
  fs.writeFileSync(path.join(dir, file), text, "utf8");
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
}

/** A repo with a real upstream, plus a second clone to push from. */
function withRemote(root: string, name: string): { repo: string; other: string } {
  git(root, "init", "-q", "--bare", "-b", "main", `${name}-origin.git`);
  const bare = path.join(root, `${name}-origin.git`);
  const repo = initRepo(path.join(root, name));
  commit(repo, "f.txt", "one\n");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "-u", "origin", "main");

  git(root, "clone", "-q", bare, `${name}-other`);
  const other = path.join(root, `${name}-other`);
  git(other, "config", "user.email", "u8@example.test");
  git(other, "config", "user.name", "u8 test");
  return { repo, other };
}

/**
 * Puts a recording `git` earlier on `$PATH` that logs its arguments and then
 * execs the real one. Counting invocations end-to-end is the only honest way to
 * prove the "one status per app" claim — nothing in the plugin is stubbed out.
 */
function installGitSpy(dir: string): () => string[] {
  const bin = path.join(dir, "spy-bin");
  const log = path.join(dir, "git-calls.log");
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(GIT)} "$@"\n`;
  fs.writeFileSync(path.join(bin, "git"), script, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
}

function indicatorDef(name: string): IndicatorDef {
  const def = gitPlugin.indicators?.[name];
  if (!def) throw new Error(`the git plugin does not define {git@${name}}`);
  return def;
}

function commandDef(name: string): PluginCommandDef {
  const def = gitPlugin.commands?.[name];
  if (!def) throw new Error(`the git plugin does not define git:${name}`);
  return def;
}

const FIELDS = ["branch", "dirty", "ahead", "behind"] as const;

/**
 * The env u8 itself reads. `$SHELL` is pinned to `/bin/sh`: `exec` runs scripts
 * through the user's interactive shell, and a developer's `~/.zshenv` rewriting
 * `$PATH` would walk straight past the spy.
 */
const ENV_KEYS = ["PATH", "SHELL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;

let saved: Record<string, string | undefined> = {};
let root: string;
let logger: RecordingLogger;
let registry: IndicatorRegistry | undefined;
let changes: IndicatorValue[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SHELL = "/bin/sh";
  // The daemon's own git calls inherit this env, so a developer's global config
  // (signing, `status.showUntrackedFiles`, hooks) cannot change the outcome.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  root = tempRoot();
  logger = recordingLogger();
  registry = undefined;
  changes = [];
});

afterEach(async () => {
  await registry?.stop();
  cleanupHarnesses();
  cleanupRoots();
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Activates the four git providers against a real workspace, as the daemon does. */
async function start(apps: Record<string, string>): Promise<IndicatorRegistry> {
  const raw: RawWorkspaceConfig = {
    name: "fixture",
    apps: Object.fromEntries(Object.entries(apps).map(([name, dir]) => [name, { path: dir }])),
  };
  const reg = createIndicatorRegistry({
    workspace: holderOf(makeWorkspace(root, raw)),
    logger,
    services: fakeServices(),
  });
  for (const name of FIELDS) reg.register({ ns: "git", name, def: indicatorDef(name) });
  reg.onChange((values) => changes.push(...values));
  registry = reg;
  await reg.start();
  return reg;
}

function value(name: string, app = "repo"): string {
  return registry?.get("git", name, app)?.value ?? "";
}

function valueOf(result: IndicatorResult): string {
  if (result === null || result === undefined) return "";
  return typeof result === "object" ? result.value : result;
}

/**
 * The context an app-scoped provider is handed, minus the registry. `store` is
 * passed in because the four cells sharing one Map is what makes them share one
 * {@link RepoMonitor} — the registry keeps one per namespace.
 */
function subscribeCtx(appPath: string, store: Map<string, unknown>): IndicatorContext {
  return {
    workspace: { id: "fixture", name: "fixture", rootDir: root, configPath: path.join(root, "u8.jsonc") },
    logger,
    store,
    exec: (cmd, opts = {}) => execCommand(cmd, { cwd: appPath, ...opts }),
    scope: "app",
    app: { name: "repo", path: appPath },
    cwd: appPath,
  };
}

function gitChanges(): IndicatorValue[] {
  return changes.filter((v) => v.ns === "git");
}

describe("git indicators", () => {
  it("reports the branch and follows a checkout without waiting for the poll", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    await start({ repo: "repo" });

    await waitFor(() => value("branch") === "main", "the branch of a fresh repo");
    // No remote: nothing to be ahead or behind of.
    expect([value("ahead"), value("behind"), value("dirty")]).toEqual(["", "", ""]);

    git(repo, "checkout", "-q", "-b", "feature");
    await waitFor(() => value("branch") === "feature", "the new branch");
    // Only the fs watch can have delivered that inside the test timeout.
    expect(FALLBACK_POLL_MS).toBeGreaterThan(5_000);
  });

  it("renders the short sha of a detached HEAD", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    const sha = git(repo, "rev-parse", "HEAD");
    await start({ repo: "repo" });
    await waitFor(() => value("branch") === "main", "the branch");

    git(repo, "checkout", "-q", "--detach", "HEAD");
    await waitFor(() => value("branch") === sha.slice(0, 7), "the detached sha");
  });

  it("counts modified, staged, deleted and untracked files, and clears when clean", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    commit(repo, "b.txt", "two\n");
    await start({ repo: "repo" });
    await waitFor(() => value("branch") === "main", "the first status");
    expect(value("dirty")).toBe("");

    fs.appendFileSync(path.join(repo, "a.txt"), "changed\n");
    fs.rmSync(path.join(repo, "b.txt"));
    fs.writeFileSync(path.join(repo, "c.txt"), "untracked\n", "utf8");
    fs.writeFileSync(path.join(repo, "d.txt"), "staged\n", "utf8");
    // Staging is last on purpose: it is the only one of the four edits that
    // touches `.git`, and therefore the only one the watcher can see. A
    // work-tree edit on its own is what the fallback poll exists for.
    git(repo, "add", "d.txt");

    await waitFor(() => value("dirty") === "4", "all four changes to be counted");
    expect(registry?.get("git", "dirty", "repo")?.tone).toBe("warn");

    fs.rmSync(path.join(repo, "c.txt"));
    git(repo, "reset", "-q", "--hard");
    await waitFor(() => value("dirty") === "", "the tree to read clean again");
  });

  it("stays empty, and never shells out, outside a repo", async () => {
    const plain = path.join(root, "repo");
    fs.mkdirSync(plain, { recursive: true });
    expect(findRepo(plain)).toBeUndefined();
    const calls = installGitSpy(root);

    await start({ repo: "repo" });
    await delay(300);

    expect(FIELDS.map((f) => value(f))).toEqual(["", "", "", ""]);
    expect(calls()).toEqual([]);
    expect(logger.warnings).toEqual([]);
  });

  it("resolves a worktree whose .git is a file", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    git(repo, "worktree", "add", "-q", "-b", "feature", path.join(root, "wt"));
    const wt = path.join(root, "wt");

    expect(fs.statSync(path.join(wt, ".git")).isFile()).toBe(true);
    expect(findRepo(wt)?.gitDir).toBe(path.join(repo, ".git", "worktrees", "wt"));

    await start({ repo: "wt" });
    await waitFor(() => value("branch") === "feature", "the worktree's branch");

    // The watch has to be on the linked git dir, not on the `.git` file.
    commit(wt, "b.txt", "two\n");
    fs.writeFileSync(path.join(wt, "c.txt"), "untracked\n", "utf8");
    git(wt, "add", "c.txt");
    await waitFor(() => value("dirty") === "1", "a change inside the worktree");
  });

  it("counts commits ahead of and behind a real upstream", async () => {
    const { repo, other } = withRemote(root, "repo");
    await start({ repo: "repo" });
    await waitFor(() => value("branch") === "main", "the first status");
    // In sync with the upstream: nothing to report on either side.
    expect([value("ahead"), value("behind")]).toEqual(["", ""]);

    commit(other, "f.txt", "two\n");
    git(other, "push", "-q", "origin", "main");
    git(repo, "fetch", "-q");
    await waitFor(() => value("behind") === "1", "the fetched upstream commit");
    expect(value("ahead")).toBe("");

    commit(repo, "g.txt", "local\n");
    await waitFor(() => value("ahead") === "1", "the local commit");
    expect(value("behind")).toBe("1");
    expect(registry?.get("git", "ahead", "repo")?.tone).toBe("info");
  });

  it("derives all four indicators from one git status, and stops on dispose", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    const calls = installGitSpy(root);

    await start({ repo: "repo" });
    await waitFor(() => value("branch") === "main", "the first status");

    // Four cells, one invocation: the whole point of the shared monitor.
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toBe("status --porcelain=v2 --branch");

    fs.writeFileSync(path.join(repo, "b.txt"), "two\n", "utf8");
    git(repo, "add", "b.txt");
    await waitFor(() => value("dirty") === "1", "the staged file");
    // One burst of watch events, one re-read — still not four.
    expect(calls()).toHaveLength(2);

    await registry?.stop();
    const settledCalls = calls().length;
    commit(repo, "c.txt", "three\n");
    await delay(WATCH_DEBOUNCE_MS * 3);
    expect(calls()).toHaveLength(settledCalls);
    expect(value("dirty")).toBe("1");
  });

  it("re-reads on a repo event but emits only when a value actually changed", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    const calls = installGitSpy(root);

    await start({ repo: "repo" });
    // Waiting for the *emission*, not just the cached value: the registry
    // batches deltas, and clearing the recorder before that batch lands would
    // make the assertion below pass for the wrong reason.
    await waitFor(
      () => gitChanges().some((v) => v.name === "branch" && v.value === "main"),
      "the first status to be announced",
    );
    changes = [];

    // A new commit on a branch with no upstream moves the sha and nothing else
    // any of the four cells reports.
    commit(repo, "b.txt", "two\n");
    await waitFor(() => calls().length === 2, "the watcher-driven re-read");
    await delay(100);

    expect(gitChanges()).toEqual([]);
  });

  it("does not re-emit a cell whose value a re-read left unchanged", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    const calls = installGitSpy(root);

    // Subscribed directly, not through the registry: the registry drops repeated
    // identical values of its own accord, so it cannot tell a plugin that emits
    // once from one that emits on every read. This is the only place that can.
    const emits: string[] = [];
    const store = new Map<string, unknown>();
    const disposers = await Promise.all(
      FIELDS.map(async (field) => {
        const def = indicatorDef(field);
        if (!def.subscribe) throw new Error(`{git@${field}} must subscribe`);
        return await def.subscribe(subscribeCtx(repo, store), (result) => {
          emits.push(`${field}=${valueOf(result)}`);
        });
      }),
    );
    try {
      await waitFor(() => emits.includes("branch=main"), "the first status");
      expect(calls()).toHaveLength(1);
      const settledEmits = [...emits];

      // A commit on a branch with no upstream moves HEAD's sha, which none of the
      // four cells reports: the re-read must happen and change nothing.
      commit(repo, "b.txt", "two\n");
      await waitFor(() => calls().length === 2, "the watcher-driven re-read");
      await delay(150);

      expect(emits).toEqual(settledEmits);
    } finally {
      for (const dispose of disposers) if (typeof dispose === "function") dispose();
    }
  });

  it("clears its cells when the repo is deleted underneath it", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "untracked\n", "utf8");
    await start({ repo: "repo" });
    await waitFor(() => value("branch") === "main" && value("dirty") === "1", "the first status");

    // The watcher is bound to `.git` itself, so its removal is an event it sees;
    // a file-bound or already-dead watcher would leave a stale branch on the row
    // until the 30 s fallback poll.
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });

    await waitFor(() => value("branch") === "" && value("dirty") === "", "the cells to clear");
    expect(logger.errors).toEqual([]);
  });

  it("disables itself with a single warning when git is missing", async () => {
    const repo = initRepo(path.join(root, "repo"));
    commit(repo, "a.txt", "one\n");
    const empty = path.join(root, "no-bin");
    fs.mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;

    await start({ repo: "repo" });
    await waitFor(
      () => logger.warnings.some((w) => w.includes("git is not available")),
      "the missing-binary warning",
    );
    await delay(200);

    expect(FIELDS.map((f) => value(f))).toEqual(["", "", "", ""]);
    expect(logger.warnings.filter((w) => w.includes("git is not available"))).toHaveLength(1);
    expect(logger.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Commands, driven through the real engine
// ---------------------------------------------------------------------------

/** `mono` is a two-subapp repo; `plain` is an app that is not a checkout. */
function harness(): Harness {
  const h = createHarness({
    dirs: ["mono/a", "mono/b", "plain"],
    config: {
      apps: {
        mono: { path: "mono", subapps: { a: { path: "a" }, b: { path: "b" } } },
        plain: { path: "plain" },
      },
    },
  });
  h.plugins.addCommand("git", "git:fetch", commandDef("fetch"));
  h.plugins.addCommand("git", "git:pull", commandDef("pull"));
  return h;
}

describe("git commands", () => {
  it("runs once per app even when several of its subapps are selected", async () => {
    const h = harness();
    initRepo(path.join(h.dir, "mono"));
    commit(path.join(h.dir, "mono"), "f.txt", "one\n");
    const calls = installGitSpy(h.dir);

    const result = await settled(h.engine.runCommand({ command: "git:fetch", targets: ["mono"] }));

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ "mono.a": "ok", "mono.b": "skipped" });
    expect(resultFor(result, "mono.b").error).toContain("once per app");
    expect(calls()).toEqual(["fetch --all --prune"]);
    // The command runs in the repo root, not in a subapp directory.
    expect(h.logs.some((l) => l.targetId === "mono.a" && l.text === "$ git fetch --all --prune")).toBe(true);
  });

  it("skips apps that are not git repos", async () => {
    const h = harness();
    initRepo(path.join(h.dir, "mono"));
    commit(path.join(h.dir, "mono"), "f.txt", "one\n");

    const result = await settled(
      h.engine.runCommand({ command: "git:fetch", targets: ["mono.a", "plain"] }),
    );

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ "mono.a": "ok", plain: "skipped" });
    expect(resultFor(result, "plain").error).toContain("does not apply");
  });

  it("refuses to pull a dirty tree and leaves the repo untouched", async () => {
    const h = harness();
    const { repo, other } = withRemote(h.dir, "mono");
    commit(other, "f.txt", "two\n");
    git(other, "push", "-q", "origin", "main");
    fs.appendFileSync(path.join(repo, "f.txt"), "local edit\n");

    const result = await settled(h.engine.runCommand({ command: "git:pull", targets: ["mono.a"] }));

    expect(result.ok).toBe(false);
    const target = resultFor(result, "mono.a");
    expect(target.state).toBe("failed");
    expect(target.error).toContain("refusing to pull");
    expect(target.error).toContain("1 uncommitted change");
    // Refused *before* touching the remote: the local commit is still the only one.
    expect(fs.readFileSync(path.join(repo, "f.txt"), "utf8")).toBe("one\nlocal edit\n");
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("fails a non-fast-forward pull with git's own message", async () => {
    const h = harness();
    const { repo, other } = withRemote(h.dir, "mono");
    commit(other, "f.txt", "theirs\n");
    git(other, "push", "-q", "origin", "main");
    commit(repo, "g.txt", "mine\n");

    const result = await settled(h.engine.runCommand({ command: "git:pull", targets: ["mono.a"] }));

    expect(result.ok).toBe(false);
    const target = resultFor(result, "mono.a");
    expect(target.state).toBe("failed");
    expect(target.error).toContain("Not possible to fast-forward");
    // The whole git message reaches the run log, not just the summary line.
    expect(h.logs.some((l) => l.text.includes("fatal: Not possible to fast-forward"))).toBe(true);
    // No silent merge: the local branch is exactly where it was.
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("fails a pull on a branch with no upstream, with git's own message", async () => {
    const h = harness();
    const repo = initRepo(path.join(h.dir, "mono"));
    commit(repo, "f.txt", "one\n");

    const result = await settled(h.engine.runCommand({ command: "git:pull", targets: ["mono.a"] }));

    expect(result.ok).toBe(false);
    const target = resultFor(result, "mono.a");
    expect(target.state).toBe("failed");
    // git's own diagnosis, not a bare exit code: "no tracking information".
    expect(target.error?.toLowerCase()).toContain("tracking information");
  });

  it("fast-forwards a clean branch that is behind", async () => {
    const h = harness();
    const { repo, other } = withRemote(h.dir, "mono");
    commit(other, "f.txt", "two\n");
    git(other, "push", "-q", "origin", "main");

    const result = await settled(h.engine.runCommand({ command: "git:pull", targets: ["mono.a"] }));

    expect(result.ok).toBe(true);
    expect(resultFor(result, "mono.a").state).toBe("ok");
    expect(fs.readFileSync(path.join(repo, "f.txt"), "utf8")).toBe("two\n");
  });
});
