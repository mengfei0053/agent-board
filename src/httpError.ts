/** Error that maps to a specific HTTP status at the API boundary. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function httpStatusOf(err: unknown, fallback = 400): number {
  const rec = err as { statusCode?: number; status?: number } | null;
  const code = rec?.statusCode ?? rec?.status;
  if (typeof code === "number" && code >= 400 && code <= 599) return code;
  return fallback;
}
