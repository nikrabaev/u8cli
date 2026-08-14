/**
 * Keyboard bindings (SPEC §9.1), as one pure dispatcher.
 *
 * Keeping this outside the components is what makes "does `x` stop the
 * selection" a unit test rather than a terminal session. The order below is the
 * whole contract: the help overlay swallows keys first, then the mode that owns
 * the screen, and only what is left reaches the list bindings — so `q` closes
 * the log view, types a `q` in the palette, and quits the app, depending on
 * where you are. A key with no meaning in the current mode is ignored.
 */
import type { DashboardController } from "./controller.js";
import type { DashboardState, TuiKey } from "./types.js";

/** Lines a page key moves, as a fraction of the visible window. */
const PAGE_FRACTION = 0.9;

export function dispatchKey(
  controller: DashboardController,
  state: DashboardState,
  input: string,
  key: TuiKey,
): void {
  // The overlay is modal: it is dismissed before anything else is considered.
  if (state.help) {
    if (key.escape === true || input === "?" || input === "q" || key.return === true) {
      controller.toggleHelp();
    }
    return;
  }

  switch (state.mode) {
    case "palette":
      palette(controller, input, key);
      return;
    case "profiles":
      profiles(controller, input, key);
      return;
    case "logs":
      logs(controller, state, input, key);
      return;
    case "list":
      list(controller, state, input, key);
      return;
  }
}

function list(
  controller: DashboardController,
  state: DashboardState,
  input: string,
  key: TuiKey,
): void {
  if (key.upArrow === true || input === "k") return controller.moveCursor(-1);
  if (key.downArrow === true || input === "j") return controller.moveCursor(1);
  if (key.pageUp === true) return controller.moveCursor(-page(state.viewport));
  if (key.pageDown === true) return controller.moveCursor(page(state.viewport));
  if (key.home === true || input === "g") return controller.setCursor(0);
  if (key.end === true || input === "G") return controller.setCursor(state.rows.length - 1);

  if (key.return === true) return void controller.openLogs();

  // A modifier the dashboard never advertised must not act: Ink reports ctrl-s
  // as a plain `s`, and the reflex that saves a file would otherwise start
  // whatever the cursor is on. Ctrl-C is the one chord this list answers.
  if (key.ctrl === true || key.meta === true) {
    if (key.ctrl === true && input === "c") controller.quit();
    return;
  }

  switch (input) {
    case "s":
      return void controller.start("selection");
    case "x":
      return void controller.stop("selection");
    case "r":
      return void controller.restart("selection");
    case "S":
      return void controller.start("profile");
    case "X":
      return void controller.stop("profile");
    case "R":
      return void controller.restart("profile");
    case ":":
    case "p":
      return controller.openPalette();
    case "P":
      return controller.openProfiles();
    case "?":
      return controller.toggleHelp();
    case "q":
      return controller.quit();
    default:
      break;
  }
}

function logs(
  controller: DashboardController,
  state: DashboardState,
  input: string,
  key: TuiKey,
): void {
  const height = state.logViewport;
  if (key.upArrow === true || input === "k") return controller.scrollLogs(-1);
  if (key.downArrow === true || input === "j") return controller.scrollLogs(1);
  if (key.pageUp === true) return controller.scrollLogs(-page(height));
  if (key.pageDown === true) return controller.scrollLogs(page(height));
  if (key.home === true || input === "g") return controller.logsTop();
  if (key.end === true || input === "G") return controller.logsBottom();
  if (key.escape === true || input === "q") return void controller.closeLogs();
  if (input === "?") return controller.toggleHelp();
  if (key.ctrl === true && input === "c") controller.quit();
}

function palette(controller: DashboardController, input: string, key: TuiKey): void {
  if (key.escape === true) return controller.closePalette();
  if (key.return === true) return void controller.paletteRun();
  if (key.tab === true) return controller.paletteToggleScope();
  if (key.upArrow === true) return controller.paletteMove(-1);
  if (key.downArrow === true) return controller.paletteMove(1);
  if (key.backspace === true || key.delete === true) return controller.paletteBackspace();
  if (key.ctrl === true) {
    // The readline habits, so the arrow keys are not the only way to move.
    if (input === "n") return controller.paletteMove(1);
    if (input === "p") return controller.paletteMove(-1);
    if (input === "c") return controller.quit();
    return;
  }
  if (isPrintable(input)) controller.paletteType(input);
}

function profiles(controller: DashboardController, input: string, key: TuiKey): void {
  if (key.upArrow === true || input === "k") return controller.profilesMove(-1);
  if (key.downArrow === true || input === "j") return controller.profilesMove(1);
  if (key.return === true) return void controller.profilesSelect();
  if (key.escape === true || input === "q" || input === "P") return controller.closeProfiles();
  if (key.ctrl === true && input === "c") controller.quit();
}

function page(height: number): number {
  return Math.max(1, Math.floor(height * PAGE_FRACTION));
}

/** Typed text, as opposed to a control sequence Ink also reports as `input`. */
function isPrintable(input: string): boolean {
  return input.length > 0 && !/\p{C}/u.test(input);
}
