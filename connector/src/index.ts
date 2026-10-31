import { loadConnectorConfig } from "./config.js";
import { startConnector } from "./run.js";

const loaded = loadConnectorConfig(process.env);
if (!loaded.ok) {
  console.error(JSON.stringify({ level: "error", message: loaded.message }));
  process.exit(1);
}

const { config } = loaded;
const log = (message: string, fields?: Record<string, string | number>) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", message, ...fields }));
};

log("connector starting", { boardId: config.boardId, relay: config.relayWsUrl, board: config.boardBaseUrl });
const connector = startConnector(config, log);

connector.ready.then(() => {
  log("connector ready", { boardId: config.boardId, generation: connector.generation() });
}).catch((error: unknown) => {
  log("connector failed before register", { message: error instanceof Error ? error.message : "error" });
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log("connector stopping", { signal });
  await connector.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
