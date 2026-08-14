/**
 * The Ink root: header, one body per mode, footer.
 *
 * It owns exactly three things — the keyboard, the terminal's size, and the
 * unmount — and delegates everything else to the controller. Anything that
 * looks like dashboard behaviour (what a key does, what a row says, when to
 * re-render) belongs there instead, where it is tested without a terminal.
 */
import { Box, useApp, useInput } from "ink";
import { useEffect } from "react";

import type { DashboardController } from "../controller.js";
import { useControllerState, useTerminalSize } from "../hooks.js";
import { frameRows, listViewport, logViewport } from "../present.js";
import type { DashboardState } from "../types.js";
import { el, type ReactElement } from "./element.js";
import { Footer } from "./Footer.js";
import { Header } from "./Header.js";
import { Help } from "./Help.js";
import { LogView } from "./LogView.js";
import { Palette } from "./Palette.js";
import { ProfileMenu } from "./ProfileMenu.js";
import { RowList } from "./RowList.js";

export interface AppProps {
  readonly controller: DashboardController;
}

export function App({ controller }: AppProps): ReactElement {
  const state = useControllerState(controller);
  const { rows } = useTerminalSize();
  const { exit } = useApp();

  useInput((input, key) => {
    controller.handleKey(input, key);
  });

  // The controller does the windowing; it only needs to know how much room the
  // terminal is offering right now, which changes when the user drags a corner.
  const listRows = listViewport(rows, state);
  const logRows = logViewport(rows, state);
  useEffect(() => {
    controller.setViewport(listRows);
  }, [controller, listRows]);
  useEffect(() => {
    controller.setLogViewport(logRows);
  }, [controller, logRows]);

  // `q` is a state change, not a call into Ink — so the same keypress works in a
  // test with no renderer attached.
  useEffect(() => {
    if (state.exited) exit();
  }, [state.exited, exit]);

  // Three boxes, three jobs, and they cannot be collapsed into fewer.
  //
  // The root fixes the frame's height so the footer has a bottom to sit on. The
  // body wrapper is the only thing allowed to shrink, so an over-tall body is
  // absorbed there instead of squeezing the chrome. The mode components inside
  // it refuse to shrink (see their own boxes) because Ink's default
  // `flexShrink: 1` does not clip a too-tall list — yoga shrinks each row to a
  // fractional height and every other row silently disappears.
  //
  // The height is `rows - 1`, not `rows`: Ink switches to erasing the entire
  // terminal (`2J 3J`, no repaint guard) once a frame is as tall as the screen,
  // which flickers at our frame rate and is inconsistently handled by
  // multiplexers. Ink appends a newline, so `rows - 1` still fills the screen —
  // the cursor simply parks on the last line.
  return el(
    Box,
    { flexDirection: "column", height: frameRows(rows) },
    el(Header, { state }),
    el(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, overflowY: "hidden" }, body(state)),
    el(Footer, { state }),
  );
}

function body(state: DashboardState): ReactElement {
  if (state.help) return el(Help, { state });
  if (state.mode === "logs") return el(LogView, { state });
  if (state.mode === "palette") return el(Palette, { state });
  if (state.mode === "profiles") return el(ProfileMenu, { state });
  return el(RowList, { state });
}
