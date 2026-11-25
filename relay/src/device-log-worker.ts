import { parentPort, workerData } from "node:worker_threads";
import type { LogCommand, LogReply } from "./device-log-service.js";
import { DeviceLogs } from "./device-logs.js";

const port = parentPort!;
let store: DeviceLogs;
let receiptTime: number;
port.on("message", ({ command, now }: { command: LogCommand; now: number }) => {
  receiptTime = now;
  let reply: LogReply;
  try {
    let value: unknown;
    switch (command.op) {
      case "open": store = new DeviceLogs(workerData.filename, () => receiptTime); break;
      case "append": value = store.append(command.deviceId, command.entries); break;
      case "list": value = store.list(command.query); break;
      case "prune": store.pruneExpired(); break;
      case "close": store.close(); break;
    }
    reply = { ok: true, value };
  } catch {
    reply = { ok: false };
  }
  port.postMessage(reply);
  if (command.op === "close") port.close();
});
