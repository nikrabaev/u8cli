/**
 * The two bridges between Ink and the headless controller.
 *
 * Both exist so the components can stay pure functions of state: one turns the
 * controller into a React store, the other turns the terminal's size into props.
 * Neither owns any dashboard logic — put that in the controller, where it can be
 * tested without a renderer.
 */
import { useStdout } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { DashboardController } from "./controller.js";
import type { DashboardState } from "./types.js";

/** Fallbacks for a stream that reports no size (a pipe, or a test's fake). */
export const DEFAULT_ROWS = 24;
export const DEFAULT_COLUMNS = 80;

/** Below this the layout has nothing left to give; it just clips. */
const MIN_ROWS = 4;
const MIN_COLUMNS = 20;

/**
 * Subscribes to controller flushes.
 *
 * `getState` returns the same object until the next flush, which is exactly the
 * identity contract `useSyncExternalStore` needs — the controller rebuilding
 * state wholesale rather than mutating it is what makes that true.
 */
export function useControllerState(controller: DashboardController): DashboardState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

export interface TerminalSize {
  rows: number;
  columns: number;
}

/**
 * The terminal's size, updated on `resize`.
 *
 * The listener is the reason this is a hook rather than a read: a window the
 * user drags has to move the row window with it, and the subscription must come
 * off on unmount or the stream keeps the component alive.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => sizeOf(stdout));

  useEffect(() => {
    const onResize = (): void => {
      const next = sizeOf(stdout);
      // Same numbers must not be a new object: every render of the list hangs
      // off this value.
      setSize((prev) => (prev.rows === next.rows && prev.columns === next.columns ? prev : next));
    };
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

function sizeOf(stdout: { rows?: number; columns?: number }): TerminalSize {
  return {
    rows: Math.max(MIN_ROWS, stdout.rows ?? DEFAULT_ROWS),
    columns: Math.max(MIN_COLUMNS, stdout.columns ?? DEFAULT_COLUMNS),
  };
}
