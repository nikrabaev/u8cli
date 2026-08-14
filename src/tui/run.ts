/**
 * Mounting the dashboard: attach, render, and take everything back down.
 *
 * The teardown order is the whole point of this module. `attach` owns a socket,
 * the controller owns log subscriptions on the far side of it, and Ink owns the
 * terminal — so the controller must let go of its subscriptions while the
 * connection is still up, and Ink must restore the terminal whether the app
 * quit, the daemon vanished, or the process was signalled.
 */
import { render } from "ink";

import { attach } from "../daemon/index.js";
import type { Logger } from "../util/logger.js";
import { App } from "./components/App.js";
import { el } from "./components/element.js";
import { createController } from "./controller.js";
import { FAREWELL } from "./present.js";
import { dashboardClient } from "./types.js";

export interface DashboardOptions {
  /** Path to `u8.jsonc`; the daemon is spawned for it if none is running. */
  configPath: string;
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
  });

  const instance = render(el(App, { controller }), {
    stdout: opts.stdout,
    stdin: opts.stdin,
    stderr: opts.stderr ?? opts.stdout,
    // Ctrl-C is a key like any other here: the dashboard has to unsubscribe and
    // close its socket on the way out, which Ink's own exit would skip.
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const onAbort = (): void => instance.unmount();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  // An interrupt that arrived while the daemon was still starting up has already
  // fired: a listener added to an aborted signal is never called, and the
  // dashboard would come up ignoring the Ctrl-C the user already pressed.
  if (opts.signal?.aborted === true) onAbort();

  try {
    await instance.waitUntilExit();
    // Ink erases its frame on the way out, so the reassurance goes on the line
    // it leaves behind rather than in the dashboard nobody is looking at now.
    opts.stdout.write(`${FAREWELL}\n`);
    return 0;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    // Subscriptions first: they are RPCs, and they need a connection to land on.
    await controller.dispose();
    await attached.close().catch(() => undefined);
    instance.cleanup();
  }
}
