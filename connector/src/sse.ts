/** Read a text/event-stream body until it ends. Malformed blocks are skipped by the caller. */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (name: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      emitBlock(buffer.slice(0, split), onEvent);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
    }
  }
}

function emitBlock(raw: string, onEvent: (name: string, data: string) => void): void {
  let name = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length > 0) onEvent(name, data.join("\n"));
}
