#!/usr/bin/env node
/**
 * Re-records `docs/assets/dashboard.gif`, the recording at the top of the README.
 *
 * It is a recording of the real dashboard, so it goes stale the moment a
 * change alters what the dashboard draws — a key bar, a heading, a new screen —
 * and a front page that shows last month's tool is worse than one with no
 * picture. This is the one command that brings it back: it plays
 * `docs/assets/dashboard.tape` with VHS against the built CLI.
 *
 * Everything the recording touches is thrown away afterwards: a copy of
 * `examples/demo` made into a git repository of its own (so the instance the
 * tape creates is a worktree of that copy, never of this repo), a state dir,
 * and the daemon it spawns — which is stopped on the way out whether the
 * recording worked or not, because VHS leaves the services it started running.
 *
 * Usage: `pnpm record`, or `node scripts/record-dashboard.js [output.gif]`
 * after a build. Needs `vhs` and `gifsicle` on PATH.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tape = path.join(root, "docs", "assets", "dashboard.tape");
const cli = path.join(root, "dist", "cli", "main.js");
const output = path.resolve(process.argv[2] ?? path.join(root, "docs", "assets", "dashboard.gif"));

const fail = (message) => {
  console.error(`record-dashboard: ${message}`);
  process.exit(1);
};

/** Runs a command to completion; a failure ends the recording with its name. */
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status ?? result.signal}`);
};

/** Resolves true when something is already listening on `port`. */
const inUse = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
  });

for (const tool of ["vhs", "gifsicle", "git"]) {
  if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error) {
    fail(`${tool} is not on PATH — on macOS: brew install vhs gifsicle`);
  }
}
if (!existsSync(cli)) fail("dist/ is missing — `pnpm record` builds first; on its own this script needs `pnpm build`");

// Short on purpose: the daemon's socket lives under it, and a unix socket path is capped near 104 bytes.
const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "u8-rec-")));
const workspace = path.join(work, "ws");
const state = path.join(work, "state");
// For this process too: reading the demo's config below must not go looking in
// the developer's own state home for instances of it.
process.env.U8_STATE_HOME = state;
const env = { ...process.env };

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  // Before the directory goes: the daemon would notice its state dir vanish and
  // stop by itself, but not before this script has returned.
  spawnSync(process.execPath, [cli, "--config", path.join(workspace, "u8.jsonc"), "daemon", "stop", "--force"], {
    env,
    stdio: "ignore",
  });
  rmSync(work, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

try {
  // A local instance's worktrees under examples/demo/.u8 are not part of the demo.
  cpSync(path.join(root, "examples", "demo"), workspace, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".u8",
  });
  writeFileSync(path.join(workspace, ".gitignore"), ".u8/\n");
  const git = ["-c", "user.name=u8", "-c", "user.email=u8@example.test"];
  run("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  run("git", [...git, "add", "-A"], { cwd: workspace });
  run("git", [...git, "commit", "-q", "-m", "demo workspace"], { cwd: workspace });

  // Base listens on the ports the demo declares; a recording of a stack that
  // could not bind them is a recording of four crashes.
  const { loadWorkspaceFrom } = await import(pathToFileURL(path.join(root, "dist", "config", "index.js")).href);
  const ports = loadWorkspaceFrom(path.join(workspace, "u8.jsonc")).apps.flatMap((app) => Object.values(app.ports));
  const busy = [];
  for (const port of ports) if (await inUse(port)) busy.push(port);
  if (busy.length > 0) {
    throw new Error(`the demo's port${busy.length === 1 ? "" : "s"} ${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} in use — stop whatever holds ${busy.length === 1 ? "it" : "them"} (a demo stack left running?) and record again`);
  }

  mkdirSync(path.join(work, "bin"));
  mkdirSync(state);
  const wrapper = path.join(work, "bin", "u8");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  // Sourced by the tape before it starts showing: what the viewer sees is a
  // clean prompt in a directory with a believable name.
  writeFileSync(
    path.join(work, "setup.sh"),
    [
      `export PATH="${path.join(work, "bin")}:$PATH" U8_STATE_HOME="${state}"`,
      String.raw`PS1='\[\e[38;5;245m\]~/work/u8-demo \[\e[38;5;141m\]❯\[\e[0m\] '`,
      `cd "${workspace}"`,
      "",
    ].join("\n"),
  );

  // From `work`: the tape writes its output, and sources setup.sh, relative to it.
  run("vhs", [tape], { cwd: work, env });

  mkdirSync(path.dirname(output), { recursive: true });
  // Merges the frames in which nothing moves; at this strength the loss does
  // not show on flat terminal colours, and it is a third of the file.
  run("gifsicle", ["-O3", "--lossy=30", path.join(work, "dashboard.gif"), "-o", output]);
  const shown = path.relative(process.cwd(), output);
  console.log(
    `recorded ${shown.startsWith("..") ? output : shown} (${Math.round(statSync(output).size / 1024)} KB) — ` +
      "watch it before committing, and keep the alt text in README.md in step with the tape",
  );
} catch (err) {
  cleanup();
  fail(err instanceof Error ? err.message : String(err));
} finally {
  cleanup();
}
