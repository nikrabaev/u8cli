#!/usr/bin/env node
// Demo microservice: HTTP server with a health endpoint and periodic chatter.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3000);
const NAME = process.env.SERVICE_NAME ?? "api";
const READY_AFTER_MS = Number(process.env.READY_AFTER_MS ?? 1500);

const startedAt = Date.now();
const ready = () => Date.now() - startedAt >= READY_AFTER_MS;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    const ok = ready();
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: NAME, ready: ok, uptimeMs: Date.now() - startedAt }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ service: NAME, ok: true }));
});

server.listen(PORT, () => {
  console.log(`[${NAME}] listening on :${PORT} (ready in ${READY_AFTER_MS}ms)`);
});

const timer = setInterval(() => {
  console.log(`[${NAME}] heartbeat uptime=${Math.round((Date.now() - startedAt) / 1000)}s`);
}, 5000);

const shutdown = (signal) => {
  console.log(`[${NAME}] received ${signal}, shutting down`);
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
