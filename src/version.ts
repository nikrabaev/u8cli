import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Package version, read from the shipped package.json at runtime. */
export const VERSION: string = (() => {
  try {
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
