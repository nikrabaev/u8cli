/**
 * Template renderer: parsed nodes + a value lookup → one row string.
 *
 * Pure and synchronous by design — the TUI re-renders rows on every indicator
 * delta, and the headless CLI renders the same rows from the same cache, so this
 * must never reach for I/O or daemon state.
 */
import type { IndicatorTone, IndicatorValue } from "../ipc/protocol.js";
import { applyStyle, stripAnsi, type Style } from "./ansi.js";
import { applyModifiers } from "./modifiers.js";
import { parseTemplate, type ParsedTemplate, type TemplateNode } from "./parse.js";

/** Resolves a `{ns@name}` token against the indicator cache. */
export type IndicatorLookup = (ns: string, name: string) => IndicatorValue | undefined;

export interface RenderOptions {
  /**
   * `false` emits zero escape bytes — used by `--json`, pipes, and tests. Escapes
   * a *value* carried (colored command stdout behind an `x@` indicator) are
   * stripped too: "no color" has to mean the whole row.
   */
  color: boolean;
}

/** Tone is the indicator's *suggested* styling; any explicit modifier replaces it. */
const TONE_STYLES: Record<IndicatorTone, Style> = {
  ok: { color: "green" },
  warn: { color: "yellow" },
  error: { color: "red" },
  muted: { color: "gray", dim: true },
  info: { color: "cyan" },
};

const UNKNOWN_STYLE: Style = { color: "red" };

const DEFAULT_OPTIONS: RenderOptions = { color: true };

/**
 * Accepts a raw template or a pre-parsed one; hot render paths should parse once
 * and reuse, since templates only change on config reload.
 */
export function renderTemplate(
  template: string | ParsedTemplate,
  lookup: IndicatorLookup,
  opts: RenderOptions = DEFAULT_OPTIONS,
): string {
  const parsed = typeof template === "string" ? parseTemplate(template) : template;
  let out = "";
  for (const node of parsed.nodes) out += renderNode(node, lookup, opts);
  return out;
}

function renderNode(node: TemplateNode, lookup: IndicatorLookup, opts: RenderOptions): string {
  if (node.kind === "literal") return node.text;

  const value = lookup(node.ns, node.name);
  if (value === undefined) {
    // Spec §4: an unknown indicator is a visible red marker, not a crash and not
    // a blank — a silently empty column hides the mistake.
    return paint(`{${node.ns}@${node.name}!}`, UNKNOWN_STYLE, opts);
  }

  const raw = value.display ?? value.value;
  const base = value.tone === undefined ? {} : TONE_STYLES[value.tone];
  const { text, style } = applyModifiers(raw, node.modifiers, base);
  return paint(text, style, opts);
}

function paint(text: string, style: Style, opts: RenderOptions): string {
  return opts.color ? applyStyle(text, style) : stripAnsi(text);
}
