/**
 * `u8 init` — writes a commented `u8.jsonc` skeleton.
 *
 * The skeleton is deliberately minimal-but-valid: one repo that loads cleanly,
 * with every other feature present as a commented example. It doubles as the
 * config reference most users will ever read, so it is kept in sync with the
 * schema by a round-trip test.
 */
import fs from "node:fs";
import path from "node:path";
import { U8Error } from "../util/errors.js";
import { CONFIG_FILENAME } from "../util/paths.js";

/** Renders the skeleton for a workspace named `name`. */
export function skeletonConfig(name: string): string {
  return `{
  // Editor completion for this file. Ships with the u8cli package.
  "$schema": "https://unpkg.com/u8cli/schema.json",

  "name": ${JSON.stringify(name)},

  // Row templates: literal text plus {namespace@indicator} tokens with optional
  // :modifiers — pad(n), max(n), color(name), dim, bold. An indicator declared
  // under "indicators" below is written without a namespace: {version}.
  // "templates": {
  //   "repo": "{repo@name:pad(24)} {repo@dirname:dim} {git@branch:color(yellow)}",
  //   "app": "  {app@status} {app@name:pad(22)} {health@status}"
  // },

  // Env for every process. Merge order: workspace -> repo -> app. A value may
  // reference a declared port or the instance it runs in — \${ports.http},
  // \${api.ports.http}, \${instance.name}. Scripts are never interpolated:
  // they read what they need from this env.
  // "env": { "NODE_ENV": "development" },

  // Parallel copies of the workspace (\`u8 instance create\`, \`u8 up\`): where
  // their git worktrees go and which ports they are allocated from.
  // "instances": { "dir": ".u8/worktrees", "ports": { "from": 20000, "to": 20999 } },

  // Extra indicators, rendered as {version}. The command runs in each
  // target's cwd; trimmed stdout is the value.
  // "indicators": {
  //   "version": { "cmd": "jq -r .version package.json", "interval": 60000 }
  // },

  // Local files (./…) or npm package names, loaded into the daemon. An entry may
  // also be an object, whose "options" are passed to the plugin's factory export.
  // "plugins": [
  //   "./plugins/deploy.ts",
  //   { "spec": "@acme/u8-metrics", "options": { "endpoint": "http://localhost:9090" } }
  // ],

  // Built-in plugins. git and health are on by default and take no options.
  // The protos built-in stays off until you name the shared packages it links;
  // it then contributes link/unlink commands and per-package version indicators.
  // "builtins": {
  //   "git": true,
  //   "health": true,
  //   "protos": {
  //     "packages": ["@myorg/protos", "@myorg/react-query"],
  //     "interval": 10000
  //   }
  // },

  // "limits": { "stopTimeout": 10000, "readyTimeout": 60000, "taskConcurrency": 4 },

  "repos": {
    "example": {
      // Absolute, ~-relative, or relative to this file.
      "path": ".",

      // Arbitrary shell strings, run with $SHELL in the target's cwd.
      // The "start" and "stop" entries back \`u8 start\` / \`u8 stop\`; with no
      // stop script u8 signals the process group instead.
      "scripts": {
        "start": "echo 'replace me with your dev server' && sleep 3600"
      },

      // Declare a port once and reference it: base listens on the number
      // written here, every other instance is allocated its own.
      // "ports": { "http": 3000 },
      // "env": { "PORT": "\${ports.http}" },
      // "restart": "on-crash",
      // "health": { "http": "http://localhost:\${ports.http}/healthz" },
      // "health": { "cmd": "pg_isready -q", "interval": 5000, "threshold": 2 },
      // "dependsOn": ["db"],

      // What a fresh checkout of this repo needs before it can run, and what
      // to undo when its instance is destroyed.
      // "instance": {
      //   "copy": [".env"],
      //   "init": ["pnpm install"],
      //   "teardown": ["echo bye"]
      // },

      // A monorepo declares apps instead — each one is separately runnable
      // as "example.web" / "example.api". Anything set on the repo above becomes
      // the default for every app; the app entry overrides it.
      // "apps": {
      //   "web": { "path": "apps/web", "scripts": { "start": "pnpm dev" } },
      //   "api": {
      //     "path": "apps/api",
      //     "scripts": { "start": "pnpm dev --port 3001" },
      //     "dependsOn": ["example.web"]
      //   }
      // }
    }
  },

  // Named selections of targets. At most one may be "default": true; with none
  // declared at all, u8 synthesizes an "all" profile covering every repo.
  // "profiles": {
  //   "full": { "default": true, "targets": ["example"] },
  //   "frontend": { "targets": ["example.web"] }
  // },

  // Command names are bare — ":" is reserved for core (app:start) and plugins.
  // "commands": {
  //   "test": {
  //     "script": "pnpm test",           // run in every selected target's cwd
  //     "targets": { "example": null }   // null skips this target
  //   },
  //   "deploy": {
  //     "kind": "task",
  //     "concurrency": 1,
  //     "targets": { "example": "./scripts/deploy.sh" },
  //     "hooks": { "pre": "git diff --quiet || exit 1", "post": "echo deployed" }
  //   }
  // }
}
`;
}

/** Writes the skeleton into `dir`, refusing to clobber an existing config. */
export function writeSkeletonConfig(dir: string = process.cwd()): string {
  const root = path.resolve(dir);
  const target = path.join(root, CONFIG_FILENAME);
  fs.mkdirSync(root, { recursive: true });
  try {
    // `wx` is the refusal: it fails on an existing file — including a symlink
    // pointing at one — instead of racing an `existsSync` check.
    fs.writeFileSync(target, skeletonConfig(path.basename(root)), { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new U8Error("CONFIG_INVALID", `${CONFIG_FILENAME} already exists at ${target}`, {
        configPath: target,
      });
    }
    throw e;
  }
  return target;
}
