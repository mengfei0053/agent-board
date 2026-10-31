import type { Envelope } from "../src/protocol.js";

export class Inbox {
  readonly messages: Envelope[] = [];
  private readonly listeners = new Set<() => void>();

  push(message: Envelope): void {
    this.messages.push(message);
    for (const listener of this.listeners) listener();
  }

  async wait(pred: (message: Envelope) => boolean, timeoutMs: number): Promise<Envelope> {
    const existing = this.messages.find(pred);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onMessage);
        const seen = this.messages.map((message) => message.type).join(", ") || "(none)";
        reject(new Error(`timed out after ${timeoutMs}ms. saw: ${seen}`));
      }, timeoutMs);

      const onMessage = () => {
        const found = this.messages.find(pred);
        if (!found) return;
        clearTimeout(timer);
        this.listeners.delete(onMessage);
        resolve(found);
      };

      this.listeners.add(onMessage);
    });
  }
}
