export type LogFields = Record<string, string | number | boolean | null>;

export function log(level: "info" | "warn" | "error", message: string, fields?: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}
