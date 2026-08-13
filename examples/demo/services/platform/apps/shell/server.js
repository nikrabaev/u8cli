#!/usr/bin/env node
// Demo micro-frontend shell (subapp of the "platform" monorepo app).
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3100);
const NAME = "shell";
const startedAt = Date.now();

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: NAME, ready: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>shell</h1>");
  })
  .listen(PORT, () => console.log(`[${NAME}] dev server on :${PORT}`));

setInterval(() => {
  console.log(`[${NAME}] hmr idle uptime=${Math.round((Date.now() - startedAt) / 1000)}s`);
}, 6000);

process.on("SIGTERM", () => {
  console.log(`[${NAME}] stopping`);
  process.exit(0);
});
