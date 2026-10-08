/**
 * The dashboard's rows — the same layout `u8 status` prints, plus what the
 * cursor needs.
 *
 * SPEC §4's rules are duplicated from `cli/status.ts` rather than imported:
 * that module builds strings for a pipe, this one builds selectable rows for a
 * cursor, and the shared part is a dozen lines. What must NOT diverge is the
 * layout itself — repo header row, app rows beneath, a single-app repo
 * merged into one row rendered with the app template, and the repo-scope
 * fallback that lets an app row mention `{git@branch}`.
 */
import type { TargetId, Templates } from "../config/types.js";
import type { IndicatorValue, SnapshotApp, SnapshotProfile, SnapshotRepo } from "../ipc/protocol.js";
import { renderTemplate, type IndicatorLookup } from "../template/index.js";

/** One selectable line. `id` is stable, so the cursor survives a rebuild. */
export interface DashboardRow {
  kind: "repo" | "app" | "merged";
  /** Repo name for `repo` rows, target id otherwise. */
  id: string;
  repoName: string;
  /** Rendered row text; carries ANSI when `color` is on. */
  text: string;
  /**
   * Apps a lifecycle key on this row acts on — its own for an app row,
   * every selected child for a repo header row.
   */
  targets: TargetId[];
}

export interface RowInput {
  repos: readonly SnapshotRepo[];
  templates: Templates;
  profile: SnapshotProfile;
  indicators: readonly IndicatorValue[];
  color: boolean;
}

export function buildRows(input: RowInput): DashboardRow[] {
  const values = indexIndicators(input.indicators);
  const selected = new Set(input.profile.appIds);
  const opts = { color: input.color };
  const rows: DashboardRow[] = [];

  for (const repo of input.repos) {
    const apps = repo.apps.filter((a) => selected.has(a.id));
    if (apps.length === 0) continue;

    // SPEC §4: a repo with one app is one row, not a header plus a child.
    const only = repo.apps.length === 1 ? apps[0] : undefined;
    if (only !== undefined) {
      rows.push({
        kind: "merged",
        id: only.id,
        repoName: repo.name,
        text: renderTemplate(
          only.template ?? repo.template ?? input.templates.app,
          appLookup(values, only, input.color),
          opts,
        ).trimEnd(),
        targets: [only.id],
      });
      continue;
    }

    rows.push({
      kind: "repo",
      id: repo.name,
      repoName: repo.name,
      text: renderTemplate(
        repo.template ?? input.templates.repo,
        repoLookup(values, repo, input.color),
        opts,
      ).trimEnd(),
      targets: apps.map((a) => a.id),
    });
    for (const app of apps) {
      rows.push({
        kind: "app",
        id: app.id,
        repoName: repo.name,
        text: renderTemplate(
          app.template ?? input.templates.app,
          appLookup(values, app, input.color),
          opts,
        ).trimEnd(),
        targets: [app.id],
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
  find(scope: "repo" | "app", owner: string, ns: string, name: string): IndicatorValue | undefined;
}

function indexIndicators(values: readonly IndicatorValue[]): IndicatorIndex {
  const byCell = new Map<string, IndicatorValue>();
  for (const value of values) byCell.set(indicatorKey(value), value);
  return { find: (scope, owner, ns, name) => byCell.get(`${scope} ${owner} ${ns} ${name}`) };
}

/**
 * Lookup for an app row, falling back to the repo's cells — without it the
 * merged row of a one-repo workspace would render `{git@branch!}` in red, since
 * git is repo-scoped and the merged row uses the *app* template.
 */
function appLookup(values: IndicatorIndex, app: SnapshotApp, color: boolean): IndicatorLookup {
  return (ns, name) =>
    legible(values.find("app", app.id, ns, name) ?? values.find("repo", app.repoName, ns, name), color);
}

function repoLookup(values: IndicatorIndex, repo: SnapshotRepo, color: boolean): IndicatorLookup {
  return (ns, name) => legible(values.find("repo", repo.name, ns, name), color);
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
