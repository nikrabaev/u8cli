/**
 * The alternate screen buffer: how the dashboard borrows the whole terminal and
 * gives it back.
 *
 * This is what `vim` and `less` do. The terminal keeps two buffers; switching to
 * the alternate one hands us a blank screen of our own, and switching back
 * restores the user's shell — prompt, scrollback and all — exactly as it was.
 * Without it a full-height frame has nowhere to live but the scrollback it
 * overwrites.
 *
 * Every byte here is written only to a TTY. The check lives at the write site
 * rather than only at the call site, because an escape sequence in a pipe is
 * corruption, and `u8 status | head` shares this process.
 */

/** Switch to the alternate buffer, then home the cursor.
 *
 * The home is load-bearing: DECSET 1049 saves the cursor and swaps buffers but
 * does not move it, so without it the first frame starts drawing wherever the
 * shell prompt happened to sit and scrolls itself into place. Deliberately no
 * `2J` — 1049h already clears the alternate buffer, and on a terminal that
 * ignores 1049 a `2J` would erase the screen the user is still using.
 */
const ENTER = "\x1b[?1049h\x1b[H";

/**
 * Undo the modes in reverse, then swap back.
 *
 * `2026l` releases a synchronized-update block in case we died between Ink's
 * begin and end markers; `25h` restores the cursor because DECTCEM is a global
 * mode that 1049l does *not* put back, so a crash before Ink's own cleanup would
 * otherwise leave the user typing invisibly; `0m` drops any half-written colour.
 */
const LEAVE = "\x1b[?2026l\x1b[?25h\x1b[0m\x1b[?1049l";

export interface AltScreen {
  /** False when the screen was never entered — nothing to restore. */
  readonly active: boolean;
  /** Switches back. Safe to call repeatedly and from an exit handler. */
  restore(): void;
}

const INACTIVE: AltScreen = { active: false, restore() {} };

/**
 * Only one dashboard may own the alternate screen at a time: nesting 1049h
 * clobbers the saved cursor, and the first restore would drop the second
 * dashboard out of the buffer it thought it owned.
 */
let held = false;

export interface AltScreenOptions {
  /** False keeps everything on the normal screen — see `U8_NO_ALT_SCREEN`. */
  enabled: boolean;
}

export function enterAltScreen(stdout: NodeJS.WriteStream, opts: AltScreenOptions): AltScreen {
  if (!opts.enabled || stdout.isTTY !== true || held) return INACTIVE;

  held = true;
  stdout.write(ENTER);
  let restored = false;

  return {
    active: true,
    restore(): void {
      if (restored) return;
      restored = true;
      held = false;
      try {
        stdout.write(LEAVE);
      } catch {
        // Reached from the process exit hook, where stdout may already be gone
        // (the EPIPE path destroys it). There is no screen left to restore and
        // nowhere to report it.
      }
    },
  };
}

/** Test seam: forget any held screen. Never call this from application code. */
export function resetAltScreenForTests(): void {
  held = false;
}
