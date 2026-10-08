/**
 * Reading the instance records a workspace keeps in its state dir.
 *
 * Instances are the local half of a workspace's definition: `u8.jsonc` says
 * what the apps are, and this file says which extra copies of them exist on
 * this machine, where their checkouts are and which ports they were given.
 * It is read here, below the daemon, because *every* reader of the config has
 * to arrive at the same set of apps — a client explaining a config error and a
 * plugin re-reading health checks must not see a smaller workspace than the
 * daemon that is supervising it.
 *
 * Only the daemon writes the file (see `daemon/instances.ts`). Reads are
 * tolerant for the reason every read of the state dir is: a stray byte in a
 * local file may cost the instances it described, never the workspace.
 */
import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../util/errors.js";
import type { InstanceRecord, InstanceRepoRecord } from "./types.js";

/** Bumped when a record's shape changes in a way an older reader would misread. */
export const INSTANCES_FILE_VERSION = 1;

export interface ReadInstances {
  records: InstanceRecord[];
  /** Why the file, or some of its entries, were ignored; absent when it read cleanly. */
  problem?: string;
}

/** Never throws: a missing file is "no instances", a broken one is that plus a reason. */
export function readInstanceRecords(file: string): ReadInstances {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
    return { records: [], problem: `cannot read ${file}: ${errorMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { records: [], problem: `${file} is not valid JSON: ${errorMessage(err)}` };
  }
  if (!isRecord(parsed)) return { records: [], problem: `${file} does not contain a JSON object` };
  if (parsed["version"] !== INSTANCES_FILE_VERSION) {
    return {
      records: [],
      problem: `${file} has version ${JSON.stringify(parsed["version"])}, expected ${INSTANCES_FILE_VERSION}`,
    };
  }
  const list = parsed["instances"];
  if (!Array.isArray(list)) return { records: [], problem: `${file} has no "instances" array` };

  const records: InstanceRecord[] = [];
  let skipped = 0;
  for (const entry of list) {
    const record = toInstanceRecord(entry);
    if (record) records.push(record);
    else skipped++;
  }
  return skipped === 0
    ? { records }
    : { records, problem: `${file}: ${skipped} malformed instance ${skipped === 1 ? "entry was" : "entries were"} ignored` };
}

/** The document the daemon writes; kept beside the reader so the two cannot drift. */
export function serializeInstanceRecords(records: readonly InstanceRecord[]): string {
  return `${JSON.stringify({ version: INSTANCES_FILE_VERSION, instances: records }, null, 2)}\n`;
}

function toInstanceRecord(value: unknown): InstanceRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { name, createdAt, repos, apps, ports, vars, initializedAt } = value;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (!isRecord(repos)) return undefined;

  const outRepos: Record<string, InstanceRepoRecord> = {};
  for (const [repoName, repo] of Object.entries(repos)) {
    if (!isRecord(repo)) return undefined;
    // A relative checkout path would resolve against whichever process read it.
    if (typeof repo["path"] !== "string" || !path.isAbsolute(repo["path"])) return undefined;
    const record: InstanceRepoRecord = { path: repo["path"], owned: repo["owned"] === true };
    if (typeof repo["branch"] === "string") record.branch = repo["branch"];
    if (repo["createdBranch"] === true) record.createdBranch = true;
    if (typeof repo["worktree"] === "string" && path.isAbsolute(repo["worktree"])) {
      record.worktree = repo["worktree"];
    }
    outRepos[repoName] = record;
  }

  const outPorts: InstanceRecord["ports"] = {};
  for (const [appId, named] of Object.entries(isRecord(ports) ? ports : {})) {
    if (!isRecord(named)) continue;
    const forApp: Record<string, number> = {};
    for (const [portName, port] of Object.entries(named)) {
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) forApp[portName] = port;
    }
    outPorts[appId] = forApp;
  }

  const outVars: Record<string, string> = {};
  for (const [key, text] of Object.entries(isRecord(vars) ? vars : {})) {
    if (typeof text === "string") outVars[key] = text;
  }

  const record: InstanceRecord = {
    name,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    repos: outRepos,
    apps: Array.isArray(apps) ? apps.filter((a): a is string => typeof a === "string") : [],
    ports: outPorts,
    vars: outVars,
  };
  if (typeof initializedAt === "number" && Number.isFinite(initializedAt)) record.initializedAt = initializedAt;
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
