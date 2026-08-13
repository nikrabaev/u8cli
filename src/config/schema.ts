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
 * App and subapp names become segments of a target id (`app.subapp`), so a name
 * containing `.` would make `"a.b"` ambiguous. `:` and `@` are namespace
 * separators for commands and indicators.
 */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Command and `x@` indicator names: bare, but dots are allowed (`db.migrate`). */
export const BARE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const nameKey = (what: string) =>
  z
    .string()
    .regex(NAME_PATTERN, `invalid ${what} name: use letters, digits, "_" or "-" (no ".", ":" or "@")`);

const posInt = z.number().int().positive();

const envMap = z.record(z.string().min(1), z.string());

const scriptMap = z.record(z.string().min(1), z.string());

/** An app name or `app.subapp`; resolved against the document in `normalize.ts`. */
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

/** Fields an app shares with its subapps: on an app they are per-subapp defaults. */
const runnableFields = {
  template: z.string().optional(),
  env: envMap.optional(),
  scripts: scriptMap.optional(),
  health: healthSchema.optional(),
  restart: restartSchema.optional(),
  dependsOn: z.array(targetRef).optional(),
  readyTimeout: posInt.optional(),
  stopTimeout: posInt.optional(),
};

export const subappSchema = z.strictObject({
  /** Relative to the app's `path`; defaults to the app directory. */
  path: z.string().min(1).optional(),
  ...runnableFields,
});

export const appSchema = z.strictObject({
  /** Absolute, `~`-prefixed, or relative to the workspace root. */
  path: z.string().min(1),
  ...runnableFields,
  subapps: z.record(nameKey("subapp"), subappSchema).optional(),
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
  scope: z.enum(["subapp", "app"]).optional(),
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

export const workspaceConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().optional(),
  env: envMap.optional(),
  templates: z
    .strictObject({
      app: z.string().optional(),
      subapp: z.string().optional(),
    })
    .optional(),
  /** npm package names or paths relative to the workspace root. */
  plugins: z.array(z.string().min(1)).optional(),
  builtins: z
    .strictObject({
      git: z.boolean().optional(),
      health: z.boolean().optional(),
    })
    .optional(),
  limits: limitsSchema.optional(),
  /**
   * Keys are validated in `normalize.ts` so the reserved-namespace rule can be
   * explained rather than surfaced as a pattern mismatch.
   */
  indicators: z.record(z.string().min(1), indicatorSchema).optional(),
  apps: z.record(nameKey("app"), appSchema),
  profiles: z.record(nameKey("profile"), profileSchema).optional(),
  commands: z.record(z.string().min(1), commandSchema).optional(),
});

export type RawWorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type RawApp = z.infer<typeof appSchema>;
export type RawSubapp = z.infer<typeof subappSchema>;
export type RawCommand = z.infer<typeof commandSchema>;
export type RawProfile = z.infer<typeof profileSchema>;
export type RawHealth = z.infer<typeof healthSchema>;
export type RawLimits = z.infer<typeof limitsSchema>;

/** Everything an app and a subapp have in common — the inheritance surface. */
export type RawRunnable = Omit<RawApp, "subapps" | "path"> & { path?: string };

/** JSON Schema for `$schema` editor support; emitted by `scripts/gen-schema.js`. */
export const jsonSchema = () => z.toJSONSchema(workspaceConfigSchema);
