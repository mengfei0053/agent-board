import { HttpError } from "./httpError.js";

/** JSON API bodies (tasks, settings, workspaces). */
export const MAX_JSON_BODY_BYTES = 1_048_576;
/** Multipart upload request, including framing overhead above the largest attachment. */
export const MAX_UPLOAD_OVERHEAD_BYTES = 512 * 1024;
/** User prompt / continue prompt / workspace instruction text. */
export const MAX_PROMPT_CHARS = 100_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_MODEL_CHARS = 200;
export const MAX_BATCH_IDS = 200;
/** Board list / SSE hello clips long text fields. Detail GET stays full. */
export const BOARD_FIELD_CHARS = 2_000;

export function assertTextLimit(
  value: string,
  max: number,
  label: string,
): void {
  if (value.length > max) {
    throw new HttpError(413, `${label} exceeds ${max} characters`);
  }
}
