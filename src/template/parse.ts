/**
 * Row-template grammar: literal text plus `{ns@indicator:mod:mod}` tokens — or a
 * bare `{indicator:mod}` for one the workspace declares itself — with `{{` /
 * `}}` escaping literal braces.
 *
 * Parsing never throws. A malformed token degrades to the literal text the user
 * typed and records a warning, because a typo in a template must not take down a
 * dashboard that is otherwise fine — the warning surfaces at config load.
 */
import { parseModifier, type Modifier } from "./modifiers.js";

export interface TemplateWarning {
  /** Offset into the template source where the offending construct starts. */
  index: number;
  /** The offending source text, e.g. `{app@nam e}`. */
  source: string;
  message: string;
}

export interface LiteralNode {
  kind: "literal";
  text: string;
}

export interface TokenNode {
  kind: "token";
  /** {@link NO_NAMESPACE} for a bare token. */
  ns: string;
  name: string;
  modifiers: Modifier[];
  /** Original `{...}` text, kept for diagnostics. */
  source: string;
}

export type TemplateNode = LiteralNode | TokenNode;

export interface ParsedTemplate {
  source: string;
  nodes: TemplateNode[];
  warnings: TemplateWarning[];
}

export interface TokenRef {
  ns: string;
  name: string;
}

/**
 * The namespace of a bare token. `{version}` names an indicator declared under
 * `indicators` in the config; core and plugin tokens always carry a namespace
 * (`{app@status}`, `{git@branch}`) and a plugin's name is never empty, so having
 * none is itself what identifies a config indicator — no word has to be
 * reserved to tell the two apart.
 */
export const NO_NAMESPACE = "";

/** `indicator` or `ns@indicator`; both halves are identifier-ish, so neither spelling can pass for the other. */
const TOKEN_HEAD = /^(?:([A-Za-z][A-Za-z0-9_-]*)@)?([A-Za-z][A-Za-z0-9_-]*)$/;

/**
 * A token's head as a template spells it: `git@branch`, or `version` for one
 * with no namespace. Everything that names an indicator to a person — the
 * unknown-token marker, a config warning, a `--json` key, a log line — goes
 * through here, so none of them shows a spelling the grammar would not accept.
 */
export function tokenLabel(ns: string, name: string): string {
  return ns === NO_NAMESPACE ? name : `${ns}@${name}`;
}

export function parseTemplate(input: string): ParsedTemplate {
  const nodes: TemplateNode[] = [];
  const warnings: TemplateWarning[] = [];
  let literal = "";

  const flush = (): void => {
    if (literal.length === 0) return;
    nodes.push({ kind: "literal", text: literal });
    literal = "";
  };

  let i = 0;
  while (i < input.length) {
    if (input.startsWith("{{", i) || input.startsWith("}}", i)) {
      literal += input.charAt(i);
      i += 2;
      continue;
    }

    if (input.charAt(i) !== "{") {
      literal += input.charAt(i);
      i += 1;
      continue;
    }

    const end = input.indexOf("}", i + 1);
    if (end === -1) {
      const source = input.slice(i);
      warnings.push({ index: i, source, message: `unterminated token "${source}"` });
      literal += source;
      break;
    }

    const source = input.slice(i, end + 1);
    const token = parseToken(input.slice(i + 1, end), i, source, warnings);
    if (token) {
      flush();
      nodes.push(token);
    } else {
      literal += source;
    }
    i = end + 1;
  }

  flush();
  return { source: input, nodes, warnings };
}

/** Every well-formed token in a template — used to warn about unknown indicators at load. */
export function templateTokens(template: string | ParsedTemplate): TokenRef[] {
  const parsed = typeof template === "string" ? parseTemplate(template) : template;
  return parsed.nodes
    .filter((n): n is TokenNode => n.kind === "token")
    .map((n) => ({ ns: n.ns, name: n.name }));
}

function parseToken(
  body: string,
  index: number,
  source: string,
  warnings: TemplateWarning[],
): TokenNode | undefined {
  const [head = "", ...modifierSources] = body.split(":");
  const match = TOKEN_HEAD.exec(head);
  if (!match) {
    warnings.push({
      index,
      source,
      message: `malformed token "${source}" (expected {indicator} or {ns@indicator})`,
    });
    return undefined;
  }

  const [, ns = NO_NAMESPACE, name = ""] = match;
  const modifiers: Modifier[] = [];
  for (const modifierSource of modifierSources) {
    const parsed = parseModifier(modifierSource);
    if (parsed.ok) modifiers.push(parsed.modifier);
    else warnings.push({ index, source, message: `${parsed.error} in "${source}"` });
  }

  return { kind: "token", ns, name, modifiers, source };
}
