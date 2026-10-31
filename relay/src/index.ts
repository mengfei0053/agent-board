import { startRelay } from "./server.js";

const setupToken = process.env.RELAY_SETUP_TOKEN ?? "";
if (!setupToken) {
  console.error("RELAY_SETUP_TOKEN is required");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
const relay = await startRelay({ port, setupToken });
console.log(`agent-board relay listening on 127.0.0.1:${relay.port}`);
