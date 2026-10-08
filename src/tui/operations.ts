/**
 * An instance action, from the request to the report.
 *
 * `u8 instance add` is one command that stays in the foreground until it can
 * say everything: what was added, where it listens, who went stale, what the
 * failing step printed. The dashboard cannot stay in the foreground — the user
 * is already looking at something else — so each action here runs detached and
 * ends by handing over a {@link Report} that says the same things. The words
 * come from `cli/instance-report.ts`; only the last clause of a sentence, the
 * one that names a key instead of a command, is the dashboard's own.
 *
 * Two answers come back from every action, at different times:
 *  - **Whether the daemon took it.** The returned promise resolves with a
 *    {@link Refusal} or with nothing. A refusal is the daemon's rule in the
 *    daemon's words — base cannot be edited, the instance is busy, the worktree
 *    has uncommitted changes — and is never re-derived or shortened here.
 *  - **How it went.** Later, through {@link OperationHost.report}.
 *
 * The requests that answer when the work does (`instance.create` makes
 * worktrees first, `run.await` waits for a run) are sent without a deadline;
 * a connection that drops rejects them, and that too becomes a report.
 */
import { STATE_SYMBOL } from "../cli/format.js";
import {
  addressesOf,
  baseDependencyMessage,
  checkoutOutcomes,
  destroyedCheckouts,
  externalDependenciesDown,
  failureTailTitle,
  readFailureTails,
  rewiredApps,
  rewiredMessage,
  typed,
} from "../cli/instance-report.js";
import type { TargetId } from "../config/types.js";
import type {
  InstanceAddParams,
  InstanceCreateParams,
  InstanceRemoveParams,
  Snapshot,
  TaskResult,
  TaskTargetState,
} from "../ipc/protocol.js";
import { stripAnsi } from "../template/index.js";
import { errorMessage, isU8Error } from "../util/errors.js";
import type { DashboardClient, ToneLine } from "./types.js";

/** No deadline: the answer is the work being done. */
const UNBOUNDED = { timeoutMs: 0 } as const;

/** Thrown to unwind an action whose dashboard has closed. Never shown. */
class Abandoned extends Error {}

/**
 * Whether an error is the daemon saying no, as opposed to the daemon not being
 * there to say anything. Only the first is a refusal; the second leaves the
 * outcome unknown, and has to be reported as that.
 */
function isRefusal(err: unknown): boolean {
  return isU8Error(err) && err.code !== "DAEMON_UNREACHABLE" && err.code !== "RPC_ERROR";
}

/** What a report can offer to do next; the controller asks before the ones that destroy. */
export type FollowUp =
  | { kind: "restart"; instance: string; targets: TargetId[] }
  /** The prune again, this time removing the worktree with what is uncommitted in it. */
  | { kind: "discard"; params: InstanceRemoveParams }
  /** The removal again, dropping the apps although their teardown failed. */
  | { kind: "force-remove"; params: InstanceRemoveParams }
  | { kind: "force-destroy"; instance: string };

export interface ReportFollowUp {
  key: string;
  label: string;
  action: FollowUp;
}

export interface Report {
  instance: string;
  title: string;
  ok: boolean;
  lines: ToneLine[];
  followUps: ReportFollowUp[];
}

/** The daemon said no before anything ran. */
export interface Refusal {
  /** As the daemon worded it. */
  message: string;
  /** Its `U8ErrorCode`, when it had one. */
  code?: string;
}

export interface OperationHost {
  client: DashboardClient;
  /** The snapshot on screen, with service states as live as the push stream. */
  live(): Snapshot;
  /** A snapshot fetched after a run: what the screen should show from now on. */
  apply(snapshot: Snapshot): void;
  /** False once the dashboard is closing; nothing is reported after that. */
  alive(): boolean;
  /** The activity lines changed. */
  changed(): void;
  report(report: Report): void;
}

export interface Operations {
  /** One line per action in flight: `feat-x: adding api — instance:init`. */
  activity(): string[];
  /**
   * `thenStart` is what `u8 up` does for a worktree it has just adopted: once
   * the init steps are through, start the apps and wait until they are ready.
   */
  create(params: InstanceCreateParams, opts?: { thenStart?: boolean }): Promise<Refusal | undefined>;
  add(params: InstanceAddParams): Promise<Refusal | undefined>;
  remove(params: InstanceRemoveParams): Promise<Refusal | undefined>;
  destroy(name: string, opts?: { force?: boolean }): Promise<Refusal | undefined>;
  init(name: string): Promise<Refusal | undefined>;
  /** Init if it has not succeeded yet, then start and wait until ready. */
  up(name: string): Promise<Refusal | undefined>;
}

interface Operation {
  id: number;
  instance: string;
  label: string;
  stage: string;
}

export function refusalOf(err: unknown): Refusal {
  return { message: errorMessage(err), code: isU8Error(err) ? err.code : undefined };
}

export function createOperations(host: OperationHost): Operations {
  const { client } = host;
  const inFlight = new Map<number, Operation>();
  let seq = 0;

  const begin = (instance: string, label: string): Operation => {
    const op: Operation = { id: ++seq, instance, label, stage: "" };
    inFlight.set(op.id, op);
    host.changed();
    return op;
  };
  const stage = (op: Operation, text: string): void => {
    op.stage = text;
    host.changed();
  };
  const end = (op: Operation): void => {
    inFlight.delete(op.id);
    host.changed();
  };

  /**
   * The run's result — unless the dashboard closed while it was awaited, in
   * which case the action is nobody's any more: nothing further is asked of a
   * connection that is being taken down, and nothing is reported.
   */
  const settle = async (runId: string): Promise<TaskResult> => {
    const result = await client.request("run.await", { runId }, UNBOUNDED);
    if (!host.alive()) throw new Abandoned();
    return result;
  };

  /** Read back rather than inferred: a forced removal fails and still removes, a refused one fails having changed nothing. */
  const fresh = async (): Promise<Snapshot> => {
    const snapshot = await client.request("workspace.snapshot", {});
    if (host.alive()) host.apply(snapshot);
    return snapshot;
  };

  /**
   * The rest of an action, once the daemon has taken it. Whatever goes wrong
   * from here on — a dropped connection, a daemon that restarted and forgot the
   * run — has no caller left to reject to, so it is reported like any outcome.
   */
  const follow = (op: Operation, title: string, work: () => Promise<Report>): void => {
    void work()
      .catch((err: unknown): Report | undefined => {
        if (err instanceof Abandoned) return undefined;
        return {
          instance: op.instance,
          title: `${title} — outcome unknown`,
          ok: false,
          lines: [
            { text: errorMessage(err), tone: "error" },
            {
              text: "the dashboard lost track of this action before it finished; the list shows the instance as it is now",
              tone: "dim",
            },
          ],
          followUps: [],
        };
      })
      .then((report) => {
        end(op);
        if (report !== undefined && host.alive()) host.report(report);
      });
  };

  const refusedReport = (instance: string, title: string, lead: ToneLine[], err: unknown): Report => ({
    instance,
    title: `${title} — refused`,
    ok: false,
    lines: [...lead, { text: errorMessage(err), tone: "error" }],
    followUps: [],
  });

  // --- what a report says ---------------------------------------------------

  /** Every target that did not make it, grouped by why, then the end of each one's log. */
  const failureLines = async (result: TaskResult): Promise<ToneLine[]> => {
    const lines: ToneLine[] = [];
    const groups = new Map<string, { state: TaskTargetState; why: string; ids: TargetId[] }>();
    for (const target of result.targets) {
      if (target.state === "ok" || (target.state === "skipped" && target.error === undefined)) continue;
      const exit = typeof target.exitCode === "number" && target.exitCode !== 0 ? `exit ${target.exitCode}` : "";
      const why = [exit, target.error ?? ""].filter((part) => part.length > 0).join(": ");
      const key = `${target.state}\n${why}`;
      const group = groups.get(key) ?? { state: target.state, why, ids: [] };
      group.ids.push(target.targetId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      lines.push({
        // The reason in full: it is the daemon's, and it is why the user is reading this.
        text: `${STATE_SYMBOL[group.state]} ${group.ids.join(", ")} ${group.state}${group.why.length > 0 ? ` — ${group.why}` : ""}`,
        tone: group.state === "skipped" ? "warn" : "error",
      });
    }
    const tails = await readFailureTails((params) => client.request("logs.read", params), result);
    for (const tail of tails) {
      lines.push({ text: "", tone: "plain" }, { text: failureTailTitle(tail), tone: "dim" });
      // A service's own colours would be read as this panel's.
      for (const text of tail.lines) lines.push({ text: stripAnsi(text), tone: "plain" });
    }
    return lines;
  };

  const addressLines = (snapshot: Snapshot, instance: string, only?: readonly string[]): ToneLine[] => {
    const addresses = addressesOf(snapshot, instance, only);
    const idWidth = Math.max(0, ...addresses.map((a) => a.id.length));
    const portWidth = Math.max(0, ...addresses.map((a) => a.port.length));
    return addresses.map((a) => ({
      text: `  ${a.id.padEnd(idWidth)}  ${a.port.padEnd(portWidth)}  ${a.url}`,
      tone: "plain" as const,
    }));
  };

  /** The neighbours a membership change left stale, and the restart that fixes it. */
  const rewired = (before: Snapshot, after: Snapshot, instance: string): { lines: ToneLine[]; followUps: ReportFollowUp[] } => {
    const stale = rewiredApps(before, after, instance);
    if (stale.length === 0) return { lines: [], followUps: [] };
    const them = stale.length === 1 ? "it" : "them";
    return {
      lines: [{ text: rewiredMessage(stale, `r here restarts ${them}, or R on the instance's section`), tone: "warn" }],
      followUps: [{ key: "r", label: `restart ${them} now`, action: { kind: "restart", instance, targets: stale } }],
    };
  };

  const leansOnBase = (snapshot: Snapshot, instance: string): ToneLine[] => {
    const down = externalDependenciesDown(snapshot, instance);
    if (down.length === 0) return [];
    const them = down.length === 1 ? "it" : "them";
    return [
      {
        text: baseDependencyMessage(instance, down, `start ${them} from ${down.length === 1 ? "its" : "their"} own section (s on the row)`),
        tone: "warn",
      },
    ];
  };

  /**
   * `app:start` with `wait`, and what there is to say once it has settled. A
   * start the daemon will not take — it is shutting down, the instance went
   * away while its init ran — is a refusal like any other, not a lost action.
   */
  const startAndReport = async (op: Operation, title: string, lead: ToneLine[]): Promise<Report> => {
    const name = op.instance;
    stage(op, "app:start — waiting until ready");
    let runId: string;
    try {
      ({ runId } = await client.request("service.start", { instance: name, wait: true }));
    } catch (err) {
      if (!isRefusal(err)) throw err;
      return refusedReport(name, title, lead, err);
    }
    const result = await settle(runId);
    const after = await fresh();
    if (!result.ok) {
      return {
        instance: name,
        title: `${title} — failed`,
        ok: false,
        lines: [
          ...lead,
          { text: `instance ${name} did not come up`, tone: "error" },
          ...(await failureLines(result)),
          ...leansOnBase(after, name),
        ],
        followUps: [],
      };
    }
    const ready = result.targets.filter((t) => t.state === "ok").length;
    return {
      instance: name,
      title,
      ok: true,
      lines: [
        ...lead,
        { text: `instance ${name} is up: ${ready} app${ready === 1 ? "" : "s"} ready`, tone: "ok" },
        ...addressLines(after, name),
        ...leansOnBase(after, name),
      ],
      followUps: [],
    };
  };

  const notInitialised = (name: string): ToneLine => ({
    text: `instance ${name} reads not initialised until its init steps have been through — fix the step, then run init again from its menu (i i)`,
    tone: "warn",
  });

  // --- actions --------------------------------------------------------------

  const create: Operations["create"] = async (params, opts = {}) => {
    const name = params.name;
    const op = begin(name, opts.thenStart === true ? "creating from this worktree" : "creating");
    let runId: string;
    try {
      ({ runId } = await client.request("instance.create", params, UNBOUNDED));
    } catch (err) {
      end(op);
      return refusalOf(err);
    }
    const title = `${name} · ${opts.thenStart === true ? "create and start" : "create"}`;
    follow(op, title, async () => {
      stage(op, "instance:init");
      const result = await settle(runId);
      if (!result.ok) {
        await fresh();
        return {
          instance: name,
          title: `${title} — init failed`,
          ok: false,
          lines: [
            { text: `instance ${name} was created, but its init steps did not finish`, tone: "error" },
            ...(await failureLines(result)),
            { text: "", tone: "plain" },
            notInitialised(name),
          ],
          followUps: [],
        };
      }
      const created: ToneLine = { text: `instance ${name} created and initialised`, tone: "ok" };
      if (opts.thenStart === true) return startAndReport(op, title, [created]);
      const after = await fresh();
      return {
        instance: name,
        title,
        ok: true,
        lines: [
          created,
          ...addressLines(after, name),
          { text: "nothing is running yet — start it from its menu (i u), or with S on its section", tone: "dim" },
        ],
        followUps: [],
      };
    });
    return undefined;
  };

  const init: Operations["init"] = async (name) => {
    const op = begin(name, "init");
    let runId: string;
    try {
      ({ runId } = await client.request("instance.init", { name }));
    } catch (err) {
      end(op);
      return refusalOf(err);
    }
    follow(op, `${name} · init`, async () => {
      stage(op, "instance:init");
      const result = await settle(runId);
      await fresh();
      if (result.ok) {
        return {
          instance: name,
          title: `${name} · init`,
          ok: true,
          lines: [{ text: `instance ${name} is initialised`, tone: "ok" }],
          followUps: [],
        };
      }
      return {
        instance: name,
        title: `${name} · init — failed`,
        ok: false,
        lines: [...(await failureLines(result)), { text: "", tone: "plain" }, notInitialised(name)],
        followUps: [],
      };
    });
    return undefined;
  };

  const up: Operations["up"] = async (name) => {
    const instance = host.live().instances.find((i) => i.name === name);
    const title = `${name} · up`;
    const op = begin(name, "up");
    let initRun: string | undefined;
    try {
      if (instance !== undefined && !instance.initialized) {
        ({ runId: initRun } = await client.request("instance.init", { name }));
      }
    } catch (err) {
      end(op);
      return refusalOf(err);
    }
    follow(op, title, async () => {
      if (initRun !== undefined) {
        stage(op, "instance:init");
        const result = await settle(initRun);
        if (!result.ok) {
          await fresh();
          return {
            instance: name,
            title: `${title} — init failed`,
            ok: false,
            lines: [...(await failureLines(result)), { text: "", tone: "plain" }, notInitialised(name)],
            followUps: [],
          };
        }
      }
      return startAndReport(op, title, []);
    });
    return undefined;
  };

  const add: Operations["add"] = async (params) => {
    const name = params.name;
    const before = host.live();
    const op = begin(name, `adding ${params.targets.join(", ")}`);
    let runId: string;
    let added: TargetId[];
    try {
      ({ runId, added } = await client.request("instance.add", params, UNBOUNDED));
    } catch (err) {
      end(op);
      return refusalOf(err);
    }
    follow(op, `${name} · add`, async () => {
      stage(op, "instance:init");
      const result = await settle(runId);
      const after = await fresh();
      const names = typed(after, added);
      // The apps are in the instance from the moment the request is accepted,
      // whatever became of their init steps — so their neighbours are rewired
      // either way, and that is said either way.
      const neighbours = rewired(before, after, name);
      if (!result.ok) {
        return {
          instance: name,
          title: `${name} · add ${names} — init failed`,
          ok: false,
          lines: [
            ...(await failureLines(result)),
            { text: "", tone: "plain" },
            {
              text: `${names} joined instance "${name}" without finishing init — fix the step, then run init again from its menu (i i)`,
              tone: "warn",
            },
            ...neighbours.lines,
            ...leansOnBase(after, name),
          ],
          followUps: neighbours.followUps,
        };
      }
      return {
        instance: name,
        title: `${name} · add ${names}`,
        ok: true,
        lines: [
          { text: `added ${names} to instance ${name}`, tone: "ok" },
          ...addressLines(after, name, added),
          { text: "not started yet — s on the new rows starts them", tone: "dim" },
          ...neighbours.lines,
          ...leansOnBase(after, name),
        ],
        followUps: neighbours.followUps,
      };
    });
    return undefined;
  };

  const remove: Operations["remove"] = async (params) => {
    const name = params.name;
    const before = host.live();
    const op = begin(name, `removing ${params.targets.join(", ")}`);
    let runId: string;
    let removed: TargetId[];
    try {
      ({ runId, removed } = await client.request("instance.remove", params, UNBOUNDED));
    } catch (err) {
      end(op);
      return refusalOf(err);
    }
    follow(op, `${name} · remove`, async () => {
      stage(op, "instance:teardown");
      const result = await settle(runId);
      const after = await fresh();
      const left = new Set(after.instances.find((i) => i.name === name)?.appIds ?? []);
      const gone = removed.filter((id) => !left.has(id));
      const names = typed(before, removed);
      const pruning = params.prune === true;

      const lines: ToneLine[] = [];
      if (!result.ok) lines.push(...(await failureLines(result)), { text: "", tone: "plain" });
      if (gone.length > 0) lines.push({ text: `removed ${typed(before, gone)} from instance ${name}`, tone: "ok" });
      for (const outcome of checkoutOutcomes(before, after, name)) {
        if (outcome.kind === "kept") {
          // Asked to go and still here: the run's own failure says why.
          const next = pruning ? "" : " — bring it back by adding an app of it (i a), or give it up from the menu (i c)";
          lines.push({ text: `${outcome.text}${next}`, tone: "dim" });
        } else {
          lines.push({
            text: outcome.note === undefined ? outcome.text : `${outcome.text} ${outcome.note}`,
            tone: outcome.kind === "shared" ? "dim" : "plain",
          });
        }
      }
      const neighbours = rewired(before, after, name);
      lines.push(...neighbours.lines);
      if (gone.length > 0) lines.push(...leansOnBase(after, name));
      if (lines.length === 0) lines.push({ text: "nothing to do", tone: "dim" });

      const followUps = [...neighbours.followUps];
      // Kept because a teardown step failed: the daemon's own next step is to force it.
      if (!result.ok && params.force !== true && removed.some((id) => left.has(id))) {
        followUps.push({
          key: "F",
          label: `remove ${names} anyway (force)…`,
          action: { kind: "force-remove", params: { ...params, force: true } },
        });
      }
      const what = names.length > 0 ? ` ${names}` : "";
      return {
        instance: name,
        title: result.ok ? `${name} · remove${what}` : `${name} · remove${what} — failed`,
        ok: result.ok,
        lines,
        followUps,
      };
    });
    return undefined;
  };

  const destroy: Operations["destroy"] = async (name, opts = {}) => {
    const before = host.live();
    const op = begin(name, "destroying");
    let runId: string;
    try {
      ({ runId } = await client.request("instance.destroy", { name, force: opts.force }));
    } catch (err) {
      end(op);
      return refusalOf(err);
    }
    follow(op, `${name} · destroy`, async () => {
      stage(op, "instance:teardown");
      const result = await settle(runId);
      const after = await fresh();
      const stillThere = after.instances.some((i) => i.name === name);
      const lines: ToneLine[] = [];
      if (!result.ok) lines.push(...(await failureLines(result)), { text: "", tone: "plain" });
      if (!stillThere) {
        lines.push({ text: `instance ${name} destroyed`, tone: "ok" });
        for (const outcome of destroyedCheckouts(before, name)) {
          lines.push({ text: outcome.note === undefined ? outcome.text : `${outcome.text} ${outcome.note}`, tone: "plain" });
        }
      }
      return {
        instance: name,
        title: stillThere ? `${name} · destroy — failed` : `${name} · destroy`,
        ok: !stillThere,
        lines,
        followUps:
          stillThere && opts.force !== true
            ? [{ key: "F", label: `destroy ${name} anyway (force)…`, action: { kind: "force-destroy", instance: name } }]
            : [],
      };
    });
    return undefined;
  };

  return {
    activity: () =>
      [...inFlight.values()].map((op) => `${op.instance}: ${op.label}${op.stage.length > 0 ? ` — ${op.stage}` : ""}`),
    create,
    add,
    remove,
    destroy,
    init,
    up,
  };
}
