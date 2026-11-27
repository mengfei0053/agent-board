/** Narrow an untrusted, already-decoded JSON object before reading its fields. */
export function fields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
