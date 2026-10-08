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
import { BASE_INSTANCE, type TargetId, type Templates } from "../config/types.js";
import type { IndicatorValue, SnapshotApp, SnapshotProfile, SnapshotRepo } from "../ipc/protocol.js";
import { applyStyle, renderTemplate, type IndicatorLookup } from "../template/index.js";

/** One selectable line. `id` is stable, so the cursor survives a rebuild. */
export interface DashboardRow {
  kind: "instance" | "repo" | "app" | "merged";
  /** `instance:<name>` for a section row, repo name for `repo` rows, target id otherwise. */
  id: string;
  /** Empty on a section row. */
  repoName: string;
  /** The instance this row belongs to; "everything in scope" for a key means this. */
  instance: string;
  /** Rendered row text; carries ANSI when `color` is on. */
  text: string;
  /**
   * Apps a lifecycle key on this row acts on — its own for an app row,
   * every selected child for a repo header row, the whole section for an
   * instance row.
   */
  targets: TargetId[];
}

/** One thing worth knowing about a section, said on its heading. */
export interface SectionFlag {
  text: string;
  tone: "info" | "warn" | "error";
}

/**
 * One instance's part of the list. Base is the active profile's apps; any
 * other instance is everything it runs.
 */
export interface RowSection {
  instance: string;
  appIds: readonly TargetId[];
  /** Apps of the section currently running, for its heading. */
  running: number;
  /** Shown after the name: the profile in base. */
  note?: string;
  /** After the count: what is wrong, or in progress. Empty when nothing is. */
  flags?: readonly SectionFlag[];
  /** Drawn as its heading alone. The heading still acts on, and counts, every app. */
  collapsed?: boolean;
}

export interface RowInput {
  repos: readonly SnapshotRepo[];
  templates: Templates;
  /**
   * The single-instance form: one unheaded list of this profile's apps. Kept
   * because it is what a workspace with only base has always drawn.
   */
  profile?: SnapshotProfile;
  /** Several instances: one headed block each, in this order. */
  sections?: readonly RowSection[];
  /**
   * Whether sections get a heading. Defaults to "when there is more than one";
   * said outright when the list is narrowed to one instance of several, which
   * still needs the heading that says whose rows these are.
   */
  headed?: boolean;
  indicators: readonly IndicatorValue[];
  color: boolean;
}

/** Stable id of a section row; cannot collide with a repo name or a target id. */
export function sectionRowId(instance: string): string {
  return `instance:${instance}`;
}

export function buildRows(input: RowInput): DashboardRow[] {
  const sections: readonly RowSection[] =
    input.sections ?? [{ instance: BASE_INSTANCE, appIds: input.profile?.appIds ?? [], running: 0 }];
  // A lone section needs no heading: the header line already says what it is,
  // and a workspace that never made an instance should look as it always did.
  const headed = input.headed ?? sections.length > 1;
  const rows: DashboardRow[] = [];
  for (const section of sections) {
    if (headed) {
      rows.push({
        kind: "instance",
        id: sectionRowId(section.instance),
        repoName: "",
        instance: section.instance,
        text: headingText(section, input.color),
        targets: [...section.appIds],
      });
      if (section.collapsed === true) continue;
    }
    rows.push(...sectionRows(input, section));
  }
  return rows;
}

const FLAG_COLOR = { info: "cyan", warn: "yellow", error: "red" } as const;

/**
 * `▾ feat-x  2/3 running · not initialised · 1 stale`.
 *
 * The marker says whether the rows beneath are drawn; the flags are what makes
 * one heading in ten worth a second look, so they carry their own colour and a
 * heading with nothing wrong ends at its count.
 */
function headingText(section: RowSection, color: boolean): string {
  const marker = section.collapsed === true ? "▸" : "▾";
  const label = `${section.instance}${section.note === undefined ? "" : ` · ${section.note}`}`;
  const count = `${section.running}/${section.appIds.length} running`;
  const flags = section.flags ?? [];
  if (!color) return [`${marker} ${label}  ${count}`, ...flags.map((flag) => flag.text)].join(" · ");
  return [
    `${applyStyle(marker, { dim: true })} ${applyStyle(label, { bold: true, color: "cyan" })}  ${applyStyle(count, { dim: true })}`,
    ...flags.map((flag) => applyStyle(flag.text, { color: FLAG_COLOR[flag.tone] })),
  ].join(applyStyle(" · ", { dim: true }));
}

function sectionRows(input: RowInput, section: RowSection): DashboardRow[] {
  const values = indexIndicators(input.indicators);
  const selected = new Set(section.appIds);
  const opts = { color: input.color };
  const rows: DashboardRow[] = [];

  for (const repo of input.repos) {
    if (repo.instance !== section.instance) continue;
    const apps = repo.apps.filter((a) => selected.has(a.id));
    if (apps.length === 0) continue;

    // SPEC §4: a repo with one app is one row, not a header plus a child.
    const only = repo.apps.length === 1 ? apps[0] : undefined;
    if (only !== undefined) {
      rows.push({
        kind: "merged",
        id: only.id,
        repoName: repo.name,
        instance: section.instance,
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
      instance: section.instance,
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
        instance: section.instance,
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
