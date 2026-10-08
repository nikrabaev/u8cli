/**
 * Mounting the dashboard: attach, render, and take everything back down.
 *
 * The teardown order is the whole point of this module. `attach` owns a socket,
 * the controller owns log subscriptions on the far side of it, and Ink owns the
 * terminal — so the controller must let go of its subscriptions while the
 * connection is still up, and Ink must restore the terminal whether the app
 * quit, the daemon vanished, or the process was signalled.
 */
import { render, type Instance } from "ink";

import { attach } from "../daemon/index.js";
import type { Logger } from "../util/logger.js";
import { App } from "./components/App.js";
import { el } from "./components/element.js";
import { createController } from "./controller.js";
import { FAREWELL } from "./present.js";
import { enterAltScreen } from "./screen.js";
import { dashboardClient } from "./types.js";

export interface DashboardOptions {
  /** Path to `u8.jsonc`; the daemon is spawned for it if none is running. */
  configPath: string;
  /** The instance to land on; every instance is listed either way. */
  instance?: string;
  /** The git worktree this was opened in, when no instance covers it yet. */
  worktree?: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /**
   * Off by default and deliberately so: this logger's warnings would be written
   * straight over Ink's frame. The dashboard says what it needs to say on
   * screen — the reconnect banner is the visible half of what this would log.
   */
  logger?: Logger;
  /** Aborted on SIGINT/SIGTERM; unmounts the app the way `q` does. */
  signal?: AbortSignal;
  /** The dashboard owns a terminal, so colour is on unless a caller says no. */
  color?: boolean;
  /**
   * Draw on the alternate screen. False renders inline exactly as before, which
   * is what a terminal that cannot switch buffers gets (see `U8_NO_ALT_SCREEN`).
   */
  altScreen?: boolean;
}

/** Runs until the user quits. Resolves with the process exit code. */
export async function runDashboard(opts: DashboardOptions): Promise<number> {
  const attached = await attach({
    configPath: opts.configPath,
    interactive: true,
    logger: opts.logger,
  });
  const controller = createController({
    client: dashboardClient(attached),
    color: opts.color ?? true,
    instance: opts.instance,
    worktree: opts.worktree,
  });

  const screen = enterAltScreen(opts.stdout, { enabled: opts.altScreen ?? true });
  let instance: Instance | undefined;

  /**
   * The last line of defence, for the exits that never reach the `finally`: a
   * second Ctrl-C, an EPIPE, an uncaught throw — all of which call
   * `process.exit`.
   *
   * Ink must be unmounted BEFORE the screen is restored. signal-exit patches
   * `process.emit`, so our `exit` listener runs before the one Ink registered;
   * restoring first would put the shell back and then let Ink paint a whole
   * dashboard frame onto it. `unmount` is idempotent, so calling it here costs
   * nothing on the paths that already did.
   */
  const onHardExit = (): void => {
    instance?.unmount();
    screen.restore();
  };
  process.on("exit", onHardExit);
  process.on("uncaughtExceptionMonitor", onHardExit);

  try {
    // Inside the try: a component that throws during the first (synchronous)
    // render would otherwise print its stack into the alternate buffer and die
    // there, taking the explanation with it.
    instance = render(el(App, { controller }), {
      stdout: opts.stdout,
      stdin: opts.stdin,
      stderr: opts.stderr ?? opts.stdout,
      // Ctrl-C is a key like any other here: the dashboard has to unsubscribe and
      // close its socket on the way out, which Ink's own exit would skip.
      exitOnCtrlC: false,
      patchConsole: false,
    });
    const live = instance;

    const onAbort = (): void => live.unmount();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // An interrupt that arrived while the daemon was still starting up has already
    // fired: a listener added to an aborted signal is never called, and the
    // dashboard would come up ignoring the Ctrl-C the user already pressed.
    // This must stay in the same synchronous turn as the await below — Ink
    // resolves its exit promise on a later tick, and unmounting after that
    // promise is created but before its resolver is installed hangs forever.
    if (opts.signal?.aborted === true) onAbort();

    try {
      await live.waitUntilExit();
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    // Restore first. `waitUntilExit` settling means Ink has finished with the
    // terminal, and putting the shell back before the RPC teardown means a
    // dispose that hangs against a dead daemon leaves the user looking at their
    // prompt rather than a frozen dashboard.
    screen.restore();
    process.off("exit", onHardExit);
    process.off("uncaughtExceptionMonitor", onHardExit);
    // Subscriptions first: they are RPCs, and they need a connection to land on.
    await controller.dispose();
    await attached.close().catch(() => undefined);
    instance?.cleanup();
  }

  // Below the restore, deliberately: written inside the alternate buffer this
  // would be discarded the moment we switched back. Out here it lands on the
  // line the shell returns to, right under the command that started us.
  opts.stdout.write(`${FAREWELL}\n`);
  return 0;
}
