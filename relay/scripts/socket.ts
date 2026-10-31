import WebSocket from "ws";
import type { Envelope } from "../src/protocol.js";
import { Inbox } from "./inbox.js";

export type RelaySocket = {
  inbox: Inbox;
  send: (message: Envelope) => void;
  close: () => Promise<void>;
  isOpen: () => boolean;
};

export async function openSocket(url: string, onMessage?: (message: Envelope) => void): Promise<RelaySocket> {
  const socket = new WebSocket(url);
  const inbox = new Inbox();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("open", onOpen);
    };
    socket.on("error", onError);
    socket.on("open", onOpen);
  });

  socket.on("error", () => {
    // A later reset should close the socket, not crash the process.
  });

  socket.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!isEnvelope(parsed)) return;
    inbox.push(parsed);
    onMessage?.(parsed);
  });

  return {
    inbox,
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    isOpen: () => socket.readyState === WebSocket.OPEN,
    close: () =>
      new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close();
      }),
  };
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && typeof record.id === "string" && typeof record.type === "string" && typeof record.ts === "number";
}
