import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.mjs";
import { loadEnvFile } from "./env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(ROOT);

// Ports are allocated centrally in C:\Claude\PORTS.md.
const PORT = Number(process.env.PORT ?? 4313);
// Loopback only: Tailscale identity headers are trusted, so nothing else may reach this server.
const HOST = "127.0.0.1";
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");

const app = await createApp({
  dataDir,
  webRoot: path.join(ROOT, "dist"),
  // `node --watch` restarts on every code edit; that must not buzz the phone each time.
  announceStart: !process.execArgv.some((arg) => arg.startsWith("--watch")),
});
await app.listen(PORT, HOST);
console.log(`MemoReader API listening on http://${HOST}:${PORT} (data: ${dataDir})`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
