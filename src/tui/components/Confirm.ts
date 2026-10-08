/**
 * The question before something that cannot be taken back.
 *
 * It says what will happen in full — which worktrees, with what in them —
 * because the confirmation is the last place to notice, and then asks for an
 * answer that cannot be given by accident: `y` for what only skips a step, the
 * instance's name for what deletes.
 */
import { Box, Text } from "ink";

import { wrapLines } from "../present.js";
import type { ConfirmState, DashboardState } from "../types.js";
import { el, type ReactElement } from "./element.js";
import { toneLine } from "./tone.js";

/** Title and prompt; the rest of the body is what will happen. */
const CHROME_LINES = 2;

export function Confirm({ state }: { readonly state: DashboardState }): ReactElement {
  const confirm = state.confirm;
  if (confirm === undefined) {
    return el(Box, { flexDirection: "column", flexShrink: 0 }, el(Text, { dimColor: true }, "nothing to confirm"));
  }
  const lines = wrapLines(confirm.lines, state.columns);
  const room = Math.max(1, state.viewport - CHROME_LINES);
  // The end is the part that says what is lost, so that is what survives a short terminal.
  const visible = lines.length > room ? lines.slice(lines.length - room) : lines;

  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    el(Text, { bold: true, color: "red", wrap: "truncate-end" }, confirm.title),
    ...visible.map((line, index) => toneLine(line, index)),
    prompt(confirm),
  );
}

function prompt(confirm: ConfirmState): ReactElement {
  if (confirm.expect === undefined) {
    return el(
      Text,
      { wrap: "truncate-end" },
      el(Text, { color: "cyan", bold: true }, "y"),
      ` to ${confirm.verb}`,
      el(Text, { dimColor: true }, " · n or esc to cancel"),
    );
  }
  return el(
    Text,
    { wrap: "truncate-end" },
    "type ",
    el(Text, { color: "cyan", bold: true }, confirm.expect),
    ` and press ↵ to ${confirm.verb}: `,
    el(Text, { bold: true }, confirm.typed),
    el(Text, { dimColor: true }, "▌"),
  );
}
