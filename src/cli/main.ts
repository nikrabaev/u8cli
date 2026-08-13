#!/usr/bin/env node
import { VERSION } from "../version.js";

async function main(argv: string[]): Promise<number> {
  // Replaced in Phase 10 by the full commander program.
  if (argv.includes("--version") || argv.includes("-V")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  process.stdout.write(`u8 ${VERSION}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
