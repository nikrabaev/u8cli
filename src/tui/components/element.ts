/**
 * Why there is no JSX in this directory.
 *
 * `u8` runs from TypeScript sources in two places that matter: the CLI binary
 * the end-to-end tests spawn, and the daemon the client auto-spawns — both go
 * through jiti (`--import jiti-register`). jiti resolves `./x.js` to `x.ts` but
 * not to `x.tsx`, and its JSX mode parses `.tsx` without the TypeScript plugin,
 * so a single `.tsx` file anywhere in the import graph makes `u8` unrunnable
 * without a build. Node's own `--experimental-strip-types` cannot load `.tsx`
 * at all.
 *
 * So the components are plain TypeScript over `createElement`, aliased to
 * {@link el} to keep the trees readable. Everything else about them is ordinary
 * React: props in, elements out, no JSX-only features in use. Tests may still
 * be written in `.tsx` — vitest transpiles those.
 */
export { createElement as el } from "react";
export type { ReactElement, ReactNode } from "react";
