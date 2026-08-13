#!/usr/bin/env node
// Demo micro-frontend that depends on the api app being ready.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3101);
const NAME = "auth-mfe";
const CRASH_AFTER_MS = Number(process.env.CRASH_AFTER_MS ?? 0);
const startedAt = Date.now();

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: NAME, ready: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>auth</h1>");
  })
  .listen(PORT, () => console.log(`[${NAME}] dev server on :${PORT}`));

setInterval(() => {
  console.log(`[${NAME}] hmr idle uptime=${Math.round((Date.now() - startedAt) / 1000)}s`);
}, 6000);

// Set CRASH_AFTER_MS to demo crash detection and the restart policy.
if (CRASH_AFTER_MS > 0) {
  setTimeout(() => {
    console.error(`[${NAME}] simulated crash`);
    process.exit(7);
  }, CRASH_AFTER_MS);
}

process.on("SIGTERM", () => {
  console.log(`[${NAME}] stopping`);
  process.exit(0);
});
