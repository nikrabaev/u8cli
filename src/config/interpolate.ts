/**
 * `${…}` references in config values.
 *
 * Interpolation exists so a value that differs per instance — a port, a database
 * name, the checkout a process runs from — is written once and resolved for
 * whichever instance the app belongs to. It is applied only where there is no
 * shell: `env` values and `health.http`. Scripts are handed to `$SHELL -c`
 * verbatim and read what they need from the environment, so a config author
 * never has to reason about two layers of `$` expansion in one string.
 *
 * This module is the grammar and nothing else: it knows what a reference looks
 * like, not what any reference is worth. `normalize.ts` supplies the values,
 * because only it knows the apps, the instances and the ports they were given.
 */

export type Segment = { kind: "text"; text: string } | { kind: "ref"; ref: string };

export interface ParsedInterpolation {
  segments: Segment[];
  /** Grammar problems; a string with any of these is not safe to render. */
  errors: string[];
}

/** Scopes whose members are fixed by u8 rather than declared in the config. */
export const BUILTIN_REFS = {
  instance: ["name", "slug", "suffix"],
  workspace: ["name", "root"],
  repo: ["name", "path"],
  base: ["path"],
  app: ["id", "name", "path"],
} as const satisfies Record<string, readonly string[]>;

export type BuiltinScope = keyof typeof BUILTIN_REFS;

export type Ref =
  /** `ports.http` reads the app's own port; `api.ports.http` another app's. */
  | { kind: "port"; target?: string; name: string }
  | { kind: "var"; name: string }
  | { kind: "builtin"; scope: BuiltinScope; field: string };

const OPEN = "${";

/**
 * Splits a string into literal text and references.
 *
 * `$${` is the escape for a literal `${`; every other `$` is literal already, so
 * `$PATH`, `a$b` and a trailing `$` pass through untouched and only a config
 * that actually writes `${` has to care that interpolation exists.
 */
export function parseInterpolation(text: string): ParsedInterpolation {
  const segments: Segment[] = [];
  const errors: string[] = [];
  let literal = "";
  let i = 0;

  const flush = (): void => {
    if (literal.length > 0) segments.push({ kind: "text", text: literal });
    literal = "";
  };

  while (i < text.length) {
    const at = text.indexOf(OPEN, i);
    if (at === -1) {
      literal += text.slice(i);
      break;
    }
    if (at > 0 && text[at - 1] === "$") {
      // `$${` — drop one `$` and keep the rest as text.
      literal += text.slice(i, at - 1) + OPEN;
      i = at + OPEN.length;
      continue;
    }
    const close = text.indexOf("}", at + OPEN.length);
    if (close === -1) {
      errors.push(`unterminated "\${" — close it with "}", or write "$\${" for a literal "\${"`);
      literal += text.slice(i);
      break;
    }
    literal += text.slice(i, at);
    const ref = text.slice(at + OPEN.length, close).trim();
    if (ref.length === 0) {
      errors.push('empty reference "${}"');
    } else {
      flush();
      segments.push({ kind: "ref", ref });
    }
    i = close + 1;
  }
  flush();
  return { segments, errors };
}

/** True when the string has nothing to resolve, which is nearly every value. */
export function isLiteral(parsed: ParsedInterpolation): boolean {
  return parsed.errors.length === 0 && parsed.segments.every((s) => s.kind === "text");
}

/**
 * Reads a reference's shape. Returns a message instead of throwing: the caller
 * is collecting every problem in the document, not stopping at the first.
 *
 * A target id may itself contain a dot (`platform.shell`), so the port form is
 * recognised from the right — `<target>.ports.<name>` — and a two-segment
 * reference is always scoped to the app that wrote it. That keeps a repo that
 * happens to be called `ports` or `instance` addressable: `ports.ports.http`.
 */
export function parseRef(ref: string): Ref | { error: string } {
  const parts = ref.split(".");
  if (parts.some((p) => p.length === 0)) return { error: `malformed reference "\${${ref}}"` };

  if (parts.length === 2) {
    const [scope, field] = parts as [string, string];
    if (scope === "ports") return { kind: "port", name: field };
    if (scope === "vars") return { kind: "var", name: field };
    if (isBuiltinScope(scope)) {
      const fields: readonly string[] = BUILTIN_REFS[scope];
      if (fields.includes(field)) return { kind: "builtin", scope, field };
      return {
        error: `unknown reference "\${${ref}}" — "${scope}" has ${fields.map((f) => `"${f}"`).join(", ")}`,
      };
    }
  }

  if (parts.length >= 3 && parts.length <= 4 && parts[parts.length - 2] === "ports") {
    const name = parts[parts.length - 1];
    if (name !== undefined) return { kind: "port", target: parts.slice(0, -2).join("."), name };
  }

  return { error: `unknown reference "\${${ref}}" — ${REFERENCE_HINT}` };
}

/**
 * What can be written inside `${…}`, for the message a wrong one gets. The
 * commonest wrong one is a shell variable, which is why it says so first.
 */
export const REFERENCE_HINT =
  "config values are not shell-expanded (write \"$${NAME}\" for a literal). Known references: " +
  "ports.<name>, <target>.ports.<name>, vars.<name>, instance.name, instance.slug, instance.suffix, " +
  "workspace.name, workspace.root, repo.name, repo.path, base.path, app.id, app.name, app.path";

function isBuiltinScope(scope: string): scope is BuiltinScope {
  return Object.prototype.hasOwnProperty.call(BUILTIN_REFS, scope);
}

export type Resolution = { value: string } | { error: string };

export interface Rendered {
  value: string;
  errors: string[];
}

/**
 * Substitutes every reference. An unresolvable one is left in place as written,
 * so the value that reaches an error message is recognisably the author's own.
 */
export function renderInterpolation(parsed: ParsedInterpolation, resolve: (ref: Ref) => Resolution): Rendered {
  const errors = [...parsed.errors];
  let value = "";
  for (const segment of parsed.segments) {
    if (segment.kind === "text") {
      value += segment.text;
      continue;
    }
    const ref = parseRef(segment.ref);
    const resolved = "error" in ref ? ref : resolve(ref);
    if ("error" in resolved) {
      errors.push(resolved.error);
      value += `\${${segment.ref}}`;
    } else {
      value += resolved.value;
    }
  }
  return { value, errors };
}
