/**
 * Shape validation for the raw `u8.jsonc` document.
 *
 * This layer only knows about *shape*: anything that needs the whole document
 * to decide (target references, dependency cycles, profile defaults, reserved
 * command namespaces) belongs in `normalize.ts`, where the error message can
 * explain the rule instead of quoting a regex.
 *
 * The module must stay side-effect free: `scripts/gen-schema.js` imports it from
 * the build output purely to emit `schema.json` for editor `$schema` support.
 */
import { z } from "zod";

/**
 * Repo and app names become segments of a target id (`repo.app`), so a name
 * containing `.` would make `"a.b"` ambiguous. `:` and `@` are namespace
 * separators for commands and indicators.
 */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Command and `x@` indicator names: bare, but dots are allowed (`db.migrate`). */
export const BARE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * An npm package name: `name` or `@scope/name`. Deliberately looser than the
 * registry's own rules (which also ban uppercase and cap the length) — the point
 * is to catch a path, a shell word or a half-typed scope before it reaches
 * `yalc`, not to re-litigate what npm will accept for a package that is already
 * installed.
 */
export const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

const nameKey = (what: string) =>
  z
    .string()
    .regex(NAME_PATTERN, `invalid ${what} name: use letters, digits, "_" or "-" (no ".", ":" or "@")`);

const packageName = (what: string) =>
  z
    .string()
    .regex(PACKAGE_NAME_PATTERN, `invalid ${what} name: expected "name" or "@scope/name"`);

/** Reported per offending index so the message points at the entry to delete. */
const rejectDuplicatePackages = (packages: readonly string[], ctx: z.RefinementCtx<readonly string[]>) => {
  const seen = new Set<string>();
  packages.forEach((name, index) => {
    if (seen.has(name)) {
      ctx.addIssue({ code: "custom", message: `duplicate package "${name}"`, path: [index] });
    }
    seen.add(name);
  });
};

const isPlainObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const posInt = z.number().int().positive();

const envMap = z.record(z.string().min(1), z.string());

/**
 * Inputs for `${vars.<name>}`. Literal strings: a var that could itself hold a
 * reference would need an evaluation order, and every case that wants one is
 * already served by writing the reference where the var would have been used.
 */
const varMap = z.record(
  z.string().regex(NAME_PATTERN, 'invalid var name: use letters, digits, "_" or "-"'),
  z.string(),
);

/**
 * Named ports. The number written here is the one the *base* instance listens
 * on; every other instance is allocated its own, which is the whole reason a
 * port is declared rather than typed into `env` three times.
 */
const portMap = z.record(
  z.string().regex(NAME_PATTERN, 'invalid port name: use letters, digits, "_" or "-"'),
  z
    .number({ error: "expected a port number" })
    .int("a port is a whole number")
    .min(1, "a port is between 1 and 65535")
    .max(65535, "a port is between 1 and 65535"),
);

const scriptMap = z.record(z.string().min(1), z.string());

/** A repo name or `repo.app`; resolved against the document in `normalize.ts`. */
const targetRef = z.string().min(1);

export const healthSchema = z
  .strictObject({
    /** GET probe; 2xx/3xx is healthy. */
    http: z.string().min(1).optional(),
    /** Shell probe; exit 0 is healthy. */
    cmd: z.string().min(1).optional(),
    interval: posInt.optional(),
    timeout: posInt.optional(),
    threshold: posInt.optional(),
  })
  .refine((h) => (h.http !== undefined) !== (h.cmd !== undefined), {
    message: 'a health check must set exactly one of "http" or "cmd"',
  });

export const restartSchema = z.enum(["no", "on-crash"]);

const scriptList = z.union([z.string().min(1), z.array(z.string().min(1))], {
  error: "expected a shell command string, or an array of them",
});

/**
 * What a fresh checkout needs before its apps can run, and what to undo when the
 * instance goes away. Shell strings like every other script: run in order, in
 * the checkout root (on a repo) or the app's directory (on an app), and a
 * failing step stops the ones after it.
 */
const appLifecycleSchema = z.strictObject({
  init: scriptList.optional(),
  teardown: scriptList.optional(),
});

const repoLifecycleSchema = z.strictObject({
  /**
   * Files copied from the base checkout before `init` runs, relative to the repo
   * root. For what git does not carry into a worktree — `.env` and its kind. A
   * path the base checkout does not have is skipped, not an error.
   */
  copy: z.array(z.string().min(1)).optional(),
  init: scriptList.optional(),
  teardown: scriptList.optional(),
});

/** Fields a repo shares with its apps: on a repo they are per-app defaults. */
const runnableFields = {
  template: z.string().optional(),
  env: envMap.optional(),
  vars: varMap.optional(),
  scripts: scriptMap.optional(),
  health: healthSchema.optional(),
  restart: restartSchema.optional(),
  dependsOn: z.array(targetRef).optional(),
  readyTimeout: posInt.optional(),
  stopTimeout: posInt.optional(),
};

export const appSchema = z.strictObject({
  /** Relative to the repo's `path`; defaults to the repo directory. */
  path: z.string().min(1).optional(),
  ports: portMap.optional(),
  instance: appLifecycleSchema.optional(),
  ...runnableFields,
});

export const repoSchema = z.strictObject({
  /** Absolute, `~`-prefixed, or relative to the workspace root. */
  path: z.string().min(1),
  /**
   * Only for a repo that is its own (implicit) app: a port belongs to one
   * process, so unlike the other fields it is never a default for several apps.
   * `normalize.ts` rejects it beside `apps` with a message that says so.
   */
  ports: portMap.optional(),
  instance: repoLifecycleSchema.optional(),
  ...runnableFields,
  apps: z.record(nameKey("app"), appSchema).optional(),
});

/**
 * Unions get an explicit message: zod's default for a failed union is a bare
 * "Invalid input", which tells a config author nothing about what was expected.
 */
const targetScript = z.union([z.string(), z.null()], {
  error: "expected a shell command string, or null to skip this target",
});

const hookScripts = z.union([z.string(), z.array(z.string())], {
  error: "expected a shell command string, or an array of them",
});

export const commandSchema = z.strictObject({
  kind: z.enum(["service", "task"]).optional(),
  description: z.string().optional(),
  /** Shared script, run in every selected target's cwd. */
  script: z.string().optional(),
  /** Per-target override; `null` skips the target. */
  targets: z.record(targetRef, targetScript).optional(),
  concurrency: posInt.optional(),
  hooks: z
    .strictObject({
      pre: hookScripts.optional(),
      post: hookScripts.optional(),
    })
    .optional(),
});

export const profileSchema = z.strictObject({
  default: z.boolean().optional(),
  targets: z.array(targetRef),
});

export const indicatorSchema = z.strictObject({
  /** Runs in the target's cwd; trimmed stdout is the value. */
  cmd: z.string().min(1),
  interval: posInt.optional(),
  scope: z.enum(["app", "repo"]).optional(),
});

/**
 * Whatever a plugin's own options are: this layer only checks that they form an
 * object, because the meaning of the keys belongs to the plugin, and validating
 * them here would mean u8 knowing every plugin's schema. They travel through
 * normalization untouched and reach the plugin's factory verbatim.
 */
const optionsMap = z.record(z.string().min(1), z.unknown());

/** A plugin entry: a bare spec, or the same spec plus options for its factory. */
export const pluginSchema = z.union(
  [
    z.string().min(1),
    z.strictObject({
      /** npm package name, or a path relative to the workspace root. */
      spec: z.string().min(1),
      options: optionsMap.optional(),
    }),
  ],
  { error: 'expected a package name or path, or { "spec": "…", "options": { … } }' },
);

/**
 * Options for the `protos` built-in. Unlike `git` and `health` it is *off* until
 * configured: it has nothing to link until a workspace names the packages its
 * apps share, which is why enabling it with a bare `true` is rejected in
 * `normalize.ts` with a message that says what is missing.
 */
export const protosOptionsSchema = z.strictObject({
  packages: z
    .array(packageName("shared package"), {
      // A missing `packages` is the mistake this built-in invites, and zod's
      // default ("expected array, received undefined") never mentions protos.
      error: (issue) =>
        issue.input === undefined
          ? 'the protos built-in needs "packages": the shared packages it links, e.g. ["@myorg/protos"]'
          : undefined,
    })
    .min(1, '"packages" must name at least one shared package, e.g. ["@myorg/protos"]')
    .superRefine(rejectDuplicatePackages),
  /** How often installed/linked versions are re-read; ms. */
  interval: posInt.optional(),
});

/**
 * A built-in that takes no options today. Passing it an object is rejected
 * rather than accepted-and-ignored, which would read exactly like a setting that
 * had taken effect.
 */
const optionlessBuiltin = (name: string) =>
  z.boolean({
    error: (issue) =>
      isPlainObject(issue.input)
        ? `the "${name}" built-in takes no options: use true or false`
        : undefined,
  });

export const builtinsSchema = z.strictObject({
  git: optionlessBuiltin("git").optional(),
  health: optionlessBuiltin("health").optional(),
  /** `true` is rejected in `normalize.ts`: enabling protos means configuring it. */
  protos: z
    .union([z.boolean(), protosOptionsSchema], {
      error: 'expected false, or options like { "packages": ["@myorg/protos"] }',
    })
    .optional(),
});

export const limitsSchema = z.strictObject({
  logMaxBytes: posInt.optional(),
  logKeep: posInt.optional(),
  taskRunsKeep: posInt.optional(),
  stopTimeout: posInt.optional(),
  readyTimeout: posInt.optional(),
  taskConcurrency: posInt.optional(),
  daemonIdle: posInt.optional(),
});

const portNumber = z.number().int().min(1).max(65535);

/** Workspace-wide settings for instances other than base. */
export const instancesSchema = z.strictObject({
  /**
   * Where u8 creates worktrees: `<dir>/<instance>/<repo>`. Relative to the
   * workspace root; defaults to `.u8/worktrees` inside it.
   */
  dir: z.string().min(1).optional(),
  /** Inclusive range instances are allocated ports from. */
  ports: z
    .strictObject({ from: portNumber, to: portNumber })
    .refine((r) => r.from <= r.to, { message: '"from" must not be greater than "to"' })
    .optional(),
});

export const workspaceConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().optional(),
  env: envMap.optional(),
  vars: varMap.optional(),
  templates: z
    .strictObject({
      repo: z.string().optional(),
      app: z.string().optional(),
    })
    .optional(),
  /** npm package names or paths relative to the workspace root, with optional options. */
  plugins: z.array(pluginSchema).optional(),
  builtins: builtinsSchema.optional(),
  limits: limitsSchema.optional(),
  instances: instancesSchema.optional(),
  /**
   * Keys are validated in `normalize.ts` so the reserved-namespace rule can be
   * explained rather than surfaced as a pattern mismatch.
   */
  indicators: z.record(z.string().min(1), indicatorSchema).optional(),
  repos: z.record(nameKey("repo"), repoSchema),
  profiles: z.record(nameKey("profile"), profileSchema).optional(),
  commands: z.record(z.string().min(1), commandSchema).optional(),
});

export type RawWorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type RawPlugin = z.infer<typeof pluginSchema>;
export type RawBuiltins = z.infer<typeof builtinsSchema>;
export type RawProtosOptions = z.infer<typeof protosOptionsSchema>;
export type RawRepo = z.infer<typeof repoSchema>;
export type RawApp = z.infer<typeof appSchema>;
export type RawCommand = z.infer<typeof commandSchema>;
export type RawProfile = z.infer<typeof profileSchema>;
export type RawHealth = z.infer<typeof healthSchema>;
export type RawLimits = z.infer<typeof limitsSchema>;

/**
 * Everything a repo and an app have in common — the inheritance surface.
 * `instance` is left out on purpose: a repo's lifecycle steps run once in the
 * checkout root and are not a default for each of its apps.
 */
export type RawRunnable = Omit<RawRepo, "apps" | "path" | "instance"> & { path?: string };

/** JSON Schema for `$schema` editor support; emitted by `scripts/gen-schema.js`. */
export const jsonSchema = () => z.toJSONSchema(workspaceConfigSchema);
