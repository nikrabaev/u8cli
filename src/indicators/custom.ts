/**
 * Indicators declared in `u8.jsonc` as a shell command, rendered as a bare
 * `{name}`.
 *
 * Declared once at workspace level, executed per owner in that owner's cwd with
 * its merged env; trimmed stdout is the value (SPEC §2.7). They are registered
 * under no namespace at all, which is what keeps them apart from core and
 * plugin providers without taking a name away from either.
 */
import type { CustomIndicatorDef } from "../config/types.js";
import type { IndicatorRegistration } from "../daemon/contracts.js";
import type { IndicatorContext } from "../plugin/types.js";
import { NO_NAMESPACE } from "../template/index.js";

/** A probe that outruns its own interval would pile up; it gets killed first. */
const PROBE_TIMEOUT_RATIO = 0.8;
const MIN_PROBE_TIMEOUT_MS = 100;
const MAX_PROBE_TIMEOUT_MS = 5_000;

/** SIGTERM → SIGKILL grace. Kept short: the next tick is already on its way. */
const MIN_KILL_GRACE_MS = 50;
const MAX_KILL_GRACE_MS = 1_000;

/**
 * Values are capped at 200 chars, so a command dumping a log file is a bug we
 * should not buffer a megabyte for.
 */
const MAX_PROBE_OUTPUT = 64 * 1024;

/** Deadline for one probe, always comfortably inside its own poll interval. */
export function probeTimeoutMs(intervalMs: number): number {
  return clamp(Math.floor(intervalMs * PROBE_TIMEOUT_RATIO), MIN_PROBE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS);
}

/**
 * Turns config-declared indicators into registrations. Re-derived on every
 * config reload, so this stays a pure function of the workspace.
 */
export function customIndicators(defs: readonly CustomIndicatorDef[]): IndicatorRegistration[] {
  return defs.map((def) => {
    const timeoutMs = probeTimeoutMs(def.intervalMs);
    return {
      ns: NO_NAMESPACE,
      name: def.name,
      def: {
        scope: def.scope,
        description: `$ ${def.cmd}`,
        update: { mode: "poll", intervalMs: def.intervalMs },
        async value(ctx: IndicatorContext) {
          const res = await ctx.exec(def.cmd, {
            timeoutMs,
            killGraceMs: clamp(Math.floor(timeoutMs / 4), MIN_KILL_GRACE_MS, MAX_KILL_GRACE_MS),
            maxBuffer: MAX_PROBE_OUTPUT,
          });
          if (res.ok) return res.stdout.trim();
          const meta = {
            cmd: def.cmd,
            exitCode: res.exitCode,
            timedOut: res.timedOut,
            stderr: res.stderr.trim().slice(0, 200),
          };
          // A probe *we* cut short — the registry stopping, or a config reload
          // re-binding it — is not the user's command misbehaving, and must not
          // be reported as one on every reload.
          if (res.signal !== null && !res.timedOut) {
            ctx.logger.debug(`indicator "${def.name}" interrupted for ${ownerOf(ctx)}`, meta);
          } else {
            // Empty, never stale: a dashboard cell showing a value the probe can
            // no longer confirm is worse than a blank one.
            ctx.logger.warn(`indicator "${def.name}" failed for ${ownerOf(ctx)}`, meta);
          }
          return "";
        },
      },
    };
  });
}

function ownerOf(ctx: IndicatorContext): string {
  return ctx.target?.id ?? ctx.repo.name;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
