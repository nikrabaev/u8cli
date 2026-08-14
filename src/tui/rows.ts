/**
 * The dashboard's rows — the same layout `u8 status` prints, plus what the
 * cursor needs.
 *
 * SPEC §4's rules are duplicated from `cli/status.ts` rather than imported:
 * that module builds strings for a pipe, this one builds selectable rows for a
 * cursor, and the shared part is a dozen lines. What must NOT diverge is the
 * layout itself — app header row, subapp rows beneath, a single-subapp app
 * merged into one row rendered with the subapp template, and the app-scope
 * fallback that lets a subapp row mention `{git@branch}`.
 */
import type { TargetId, Templates } from "../config/types.js";
import type { IndicatorValue, SnapshotApp, SnapshotProfile, SnapshotSubapp } from "../ipc/protocol.js";
import { renderTemplate, type IndicatorLookup } from "../template/index.js";

/** One selectable line. `id` is stable, so the cursor survives a rebuild. */
export interface DashboardRow {
  kind: "app" | "subapp" | "merged";
  /** App name for `app` rows, target id otherwise. */
  id: string;
  appName: string;
  /** Rendered row text; carries ANSI when `color` is on. */
  text: string;
  /**
   * Subapps a lifecycle key on this row acts on — its own for a subapp row,
   * every selected child for an app header row.
   */
  targets: TargetId[];
}

export interface RowInput {
  apps: readonly SnapshotApp[];
  templates: Templates;
  profile: SnapshotProfile;
  indicators: readonly IndicatorValue[];
  color: boolean;
}

export function buildRows(input: RowInput): DashboardRow[] {
  const values = indexIndicators(input.indicators);
  const selected = new Set(input.profile.subappIds);
  const opts = { color: input.color };
  const rows: DashboardRow[] = [];

  for (const app of input.apps) {
    const subapps = app.subapps.filter((s) => selected.has(s.id));
    if (subapps.length === 0) continue;

    // SPEC §4: an app with one subapp is one row, not a header plus a child.
    const only = app.subapps.length === 1 ? subapps[0] : undefined;
    if (only !== undefined) {
      rows.push({
        kind: "merged",
        id: only.id,
        appName: app.name,
        text: renderTemplate(
          only.template ?? app.template ?? input.templates.subapp,
          subappLookup(values, only, input.color),
          opts,
        ).trimEnd(),
        targets: [only.id],
      });
      continue;
    }

    rows.push({
      kind: "app",
      id: app.name,
      appName: app.name,
      text: renderTemplate(
        app.template ?? input.templates.app,
        appLookup(values, app, input.color),
        opts,
      ).trimEnd(),
      targets: subapps.map((s) => s.id),
    });
    for (const subapp of subapps) {
      rows.push({
        kind: "subapp",
        id: subapp.id,
        appName: app.name,
        text: renderTemplate(
          subapp.template ?? input.templates.subapp,
          subappLookup(values, subapp, input.color),
          opts,
        ).trimEnd(),
        targets: [subapp.id],
      });
    }
  }
  return rows;
}

/** Cache key of one indicator cell, matching the lookup below. */
export function indicatorKey(value: IndicatorValue): string {
  return `${value.scope} ${value.owner} ${value.ns} ${value.name}`;
}

interface IndicatorIndex {
  find(scope: "app" | "subapp", owner: string, ns: string, name: string): IndicatorValue | undefined;
}

function indexIndicators(values: readonly IndicatorValue[]): IndicatorIndex {
  const byCell = new Map<string, IndicatorValue>();
  for (const value of values) byCell.set(indicatorKey(value), value);
  return { find: (scope, owner, ns, name) => byCell.get(`${scope} ${owner} ${ns} ${name}`) };
}

/**
 * Lookup for a subapp row, falling back to the app's cells — without it the
 * merged row of a one-app workspace would render `{git@branch!}` in red, since
 * git is app-scoped and the merged row uses the *subapp* template.
 */
function subappLookup(values: IndicatorIndex, subapp: SnapshotSubapp, color: boolean): IndicatorLookup {
  return (ns, name) =>
    legible(values.find("subapp", subapp.id, ns, name) ?? values.find("app", subapp.appName, ns, name), color);
}

function appLookup(values: IndicatorIndex, app: SnapshotApp, color: boolean): IndicatorLookup {
  return (ns, name) => legible(values.find("app", app.name, ns, name), color);
}

/**
 * Without colour, a glyph is not a status: `app@status` renders as a `●` whose
 * meaning lives entirely in its tone, so a colourless dashboard falls back to
 * the raw value and reads `running` / `crashed` instead.
 */
function legible(value: IndicatorValue | undefined, color: boolean): IndicatorValue | undefined {
  if (color || value === undefined) return value;
  if (value.display === undefined || value.tone === undefined) return value;
  return { ...value, display: undefined };
}
