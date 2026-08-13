#!/usr/bin/env node
// Demo dependency: a non-HTTP service probed with a shell healthcheck.
// Writes a ready-file once "warmed up"; the healthcheck greps for it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const READY_FILE = process.env.DB_READY_FILE ?? path.join(os.tmpdir(), "u8-demo-db.ready");
const READY_AFTER_MS = Number(process.env.READY_AFTER_MS ?? 2000);

console.log("[db] starting up");
fs.rmSync(READY_FILE, { force: true });

const timer = setTimeout(() => {
  fs.writeFileSync(READY_FILE, String(process.pid));
  console.log(`[db] ready (${READY_FILE})`);
}, READY_AFTER_MS);

const heartbeat = setInterval(() => console.log("[db] accepting connections"), 7000);

const shutdown = (signal) => {
  console.log(`[db] received ${signal}, shutting down`);
  clearTimeout(timer);
  clearInterval(heartbeat);
  fs.rmSync(READY_FILE, { force: true });
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
