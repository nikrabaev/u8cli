/**
 * The few questions asked before an instance action is sent: a name, a branch,
 * which apps, what becomes of a checkout.
 *
 * One field per row and one row highlighted. A refusal from the daemon lands
 * under the fields, in full, with everything typed still in place — a name the
 * daemon will not take should cost a correction, not a second trip through
 * the form.
 */
import { Box, Text } from "ink";

import { wrapText } from "../present.js";
import { windowTopFor } from "../scroll.js";
import type { DashboardState, FormField } from "../types.js";
import { el, type ReactElement } from "./element.js";


export function Form({ state }: { readonly state: DashboardState }): ReactElement {
  const form = state.form;
  if (form === undefined) {
    return el(Box, { flexDirection: "column", flexShrink: 0 }, el(Text, { dimColor: true }, "no form"));
  }

  const current = form.fields[form.index];
  const note = current !== undefined && current.kind !== "text" ? current.note : undefined;
  const status = form.submitting ? 1 : 0;
  // What must stay whatever else is said: the title, the field the cursor is
  // on, its note, and the line that says a request is out.
  const fixed = 1 + 1 + (note === undefined ? 0 : 1) + status;
  const error = fit(form.error === undefined ? [] : wrapText(`✗ ${form.error}`, state.columns), state.viewport - fixed);
  // The refusal outranks the explanation: the user has read the one, and has
  // to read the other. On a short terminal the intro is what gives way.
  const intro = form.intro.flatMap((line) => wrapText(line, state.columns)).slice(0, Math.max(0, state.viewport - fixed - error.length));
  const chrome = 1 + intro.length + (note === undefined ? 0 : 1) + error.length + status;
  const height = Math.max(1, state.viewport - chrome);
  const top = windowTopFor(form.index, form.fields.length, height, 0);
  const visible = form.fields.slice(top, top + height);
  const labelWidth = Math.max(...form.fields.map((field) => (field.kind === "text" ? field.label.length : 0)), 0);

  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    el(Text, { bold: true, wrap: "truncate-end" }, form.title),
    ...intro.map((line, index) => el(Text, { key: `intro:${index}`, dimColor: true, wrap: "truncate-end" }, line)),
    ...(visible.length === 0
      ? [el(Text, { key: "empty", dimColor: true }, "  nothing to choose from")]
      : visible.map((field, offset) => fieldRow(field, labelWidth, top + offset === form.index))),
    note === undefined ? null : el(Text, { dimColor: true, wrap: "truncate-end" }, `    ${note}`),
    ...error.map((line, index) => el(Text, { key: `error:${index}`, color: "red", wrap: "truncate-end" }, line)),
    form.submitting ? el(Text, { color: "cyan", wrap: "truncate-end" }, "… asking the daemon") : null,
  );
}

/**
 * The refusal, whole if the terminal has the rows for it. When it has not, the
 * cut is said — a sentence that stops mid-way with no mark reads as the whole
 * of it, and the end is where a refusal says what to do.
 */
function fit(lines: string[], room: number): string[] {
  if (lines.length <= room) return lines;
  const shown = Math.max(0, room - 1);
  return [...lines.slice(0, shown), `  … ${lines.length - shown} more lines do not fit this terminal — make it taller to read the rest`].slice(
    0,
    Math.max(0, room),
  );
}

function fieldRow(field: FormField, labelWidth: number, selected: boolean): ReactElement {
  const cursor = el(Text, { color: "cyan" }, selected ? "❯ " : "  ");
  switch (field.kind) {
    case "text":
      return el(
        Text,
        { key: field.key, wrap: "truncate-end", bold: selected },
        cursor,
        el(Text, { dimColor: !selected }, `${field.label.padEnd(labelWidth)}  `),
        field.value,
        selected ? el(Text, { dimColor: true }, "▌") : null,
        // What leaving it empty means, in place of the value it stands in for.
        field.value.length === 0 && field.placeholder !== undefined
          ? el(Text, { dimColor: true, bold: false }, `${selected ? " " : ""}${field.placeholder}`)
          : null,
      );
    case "check":
      return el(
        Text,
        { key: field.key, wrap: "truncate-end", bold: selected },
        cursor,
        el(Text, { color: field.checked ? "green" : undefined }, field.checked ? "[x] " : "[ ] "),
        field.label,
      );
    case "choice":
      return el(
        Text,
        { key: field.key, wrap: "truncate-end", bold: selected },
        cursor,
        `${field.label}: `,
        ...field.options.flatMap((option) => {
          const chosen = option.value === field.value;
          return [
            el(
              Text,
              { key: option.value, color: chosen ? "green" : undefined, dimColor: !chosen, bold: selected && chosen },
              `${chosen ? "(•)" : "( )"} ${option.label}  `,
            ),
          ];
        }),
      );
  }
}
