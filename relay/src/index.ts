import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { startServer } from "./server.js";

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  log("error", loaded.message);
  process.exit(1);
}

for (const warning of loaded.warnings) log("warn", warning);

const { config } = loaded;
const server = await startServer({
  host: config.host,
  port: config.port,
  adminToken: config.adminToken,
  boardToken: config.boardToken,
  databasePath: config.databasePath,
  tokenTtlMs: config.tokenTtlMs,
  pairTtlMs: config.pairTtlMs,
  cmdTimeoutMs: config.cmdTimeoutMs,
  idempotencyTtlMs: config.idempotencyTtlMs,
  pairAttemptLimit: config.pairAttemptLimit,
  pairWindowMs: config.pairWindowMs,
  wsMessagesPerSec: config.wsMessagesPerSec,
});

log("info", "listening", { http: server.httpUrl, ws: server.wsUrl, bind: `${config.host}:${server.port}` });
if (config.generatedAdminToken) {
  log("info", "generated ADMIN_TOKEN (memory only, not written to disk)", { adminToken: config.adminToken });
} else {
  log("info", "ADMIN_TOKEN loaded from environment");
}
if (config.generatedBoardToken) {
  log("info", "generated BOARD_TOKEN (memory only, not written to disk)", { boardToken: config.boardToken });
} else {
  log("info", "BOARD_TOKEN loaded from environment");
}
if (config.databasePath) {
  log("info", "persistent device sessions and board credential hashes enabled");
} else {
  log("warn", "RELAY_DB_PATH is unset; device sessions, board credentials, and revocations are dropped on exit");
}
log("info", "pair codes, task data, logs, and sockets stay in memory and are dropped on exit");

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log("info", "shutting down", { signal });
  await server.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
