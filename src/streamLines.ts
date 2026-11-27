import { StringDecoder } from "node:string_decoder";

/** Drop a single unterminated line once it grows past this. */
export const MAX_STREAM_LINE_CHARS = 1_000_000;
/** Complete lines handled from one chunk; the rest are counted as dropped. */
export const MAX_STREAM_LINES_PER_CHUNK = 500;

export type StreamLineState = {
  decoder: StringDecoder;
  buf: string;
  /** After an over-long line, ignore bytes until the next newline. */
  discarding: boolean;
};

export function createStreamLineState(): StreamLineState {
  return { decoder: new StringDecoder("utf8"), buf: "", discarding: false };
}

export type StreamPushResult = {
  lines: string[];
  truncated: boolean;
  droppedLines: number;
};

export function pushStreamBytes(state: StreamLineState, chunk: Buffer): StreamPushResult {
  let text = state.decoder.write(chunk);
  let truncated = false;
  if (state.discarding) {
    const nl = text.indexOf("\n");
    if (nl < 0) return { lines: [], truncated: false, droppedLines: 0 };
    state.discarding = false;
    text = text.slice(nl + 1);
  }
  state.buf += text;
  const lines: string[] = [];
  // Keep the end of a burst as well as its head: final usage / completion events
  // must not get stranded as a multi-line string passed to JSON.parse on exit.
  const tailSize = 32;
  let droppedLines = 0;
  for (;;) {
    const nl = state.buf.indexOf("\n");
    if (nl < 0) break;
    let line = state.buf.slice(0, nl);
    state.buf = state.buf.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > MAX_STREAM_LINE_CHARS) {
      truncated = true;
      continue;
    }
    if (lines.length < MAX_STREAM_LINES_PER_CHUNK) lines.push(line);
    else {
      lines[MAX_STREAM_LINES_PER_CHUNK - tailSize + droppedLines % tailSize] = line;
      droppedLines++;
    }
  }
  if (state.buf.length > MAX_STREAM_LINE_CHARS) {
    state.buf = "";
    state.discarding = true;
    truncated = true;
  }
  if (droppedLines % tailSize) {
    const tail = lines.splice(MAX_STREAM_LINES_PER_CHUNK - tailSize);
    const first = droppedLines % tailSize;
    lines.push(...tail.slice(first), ...tail.slice(0, first));
  }
  return { lines, truncated, droppedLines };
}

/** Flush a trailing partial line and any bytes split across chunks. */
export function endStream(state: StreamLineState): string {
  const tail = state.decoder.end();
  if (state.discarding) {
    state.discarding = false;
    state.buf = "";
    if (!tail.includes("\n")) return "";
    state.buf = tail.slice(tail.lastIndexOf("\n") + 1);
  } else {
    state.buf += tail;
  }
  const rest = state.buf;
  state.buf = "";
  if (rest.length > MAX_STREAM_LINE_CHARS) return "";
  return rest;
}
