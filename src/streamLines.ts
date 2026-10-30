import { StringDecoder } from "node:string_decoder";

/** Drop a single unterminated line once it grows past this. */
export const MAX_STREAM_LINE_CHARS = 1_000_000;
/** Complete lines handled from one chunk; the rest are counted as dropped. */
export const MAX_STREAM_LINES_PER_CHUNK = 500;

export type StreamLineState = {
  decoder: StringDecoder;
  buf: string;
};

export function createStreamLineState(): StreamLineState {
  return { decoder: new StringDecoder("utf8"), buf: "" };
}

export type StreamPushResult = {
  lines: string[];
  truncated: boolean;
  droppedLines: number;
};

export function pushStreamBytes(state: StreamLineState, chunk: Buffer): StreamPushResult {
  state.buf += state.decoder.write(chunk);
  if (state.buf.length > MAX_STREAM_LINE_CHARS) {
    state.buf = "";
    return { lines: [], truncated: true, droppedLines: 0 };
  }
  const parts = state.buf.split(/\r?\n/);
  state.buf = parts.pop() ?? "";
  if (parts.length > MAX_STREAM_LINES_PER_CHUNK) {
    return {
      lines: parts.slice(0, MAX_STREAM_LINES_PER_CHUNK),
      truncated: false,
      droppedLines: parts.length - MAX_STREAM_LINES_PER_CHUNK,
    };
  }
  return { lines: parts, truncated: false, droppedLines: 0 };
}

/** Flush a trailing partial line and any bytes split across chunks. */
export function endStream(state: StreamLineState): string {
  state.buf += state.decoder.end();
  const rest = state.buf;
  state.buf = "";
  return rest;
}
