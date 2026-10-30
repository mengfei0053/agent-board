/** Codex sandbox toggle (meta.codex_sandbox). Default ON = --approve-for-me. */
import { getPool } from "./db.js";

const META_KEY = "codex_sandbox";

/** true = use workspace-write sandbox (--approve-for-me); false = -s danger-full-access */
let enabled = true;

function parseStored(raw: string | null | undefined): boolean {
  if (raw == null || !String(raw).trim()) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  try {
    const j = JSON.parse(raw) as unknown;
    if (typeof j === "boolean") return j;
    if (typeof j === "number") return j !== 0;
    if (typeof j === "string") {
      const s = j.trim().toLowerCase();
      if (s === "0" || s === "false" || s === "off" || s === "no") return false;
      if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
    }
  } catch {
    /* keep default */
  }
  return true;
}

export async function loadCodexSandbox(): Promise<void> {
  const p = getPool();
  const res = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [META_KEY],
  );
  enabled = parseStored(res.rows[0]?.value);
}

export function isCodexSandboxEnabled(): boolean {
  return enabled;
}

export function getCodexSandboxSettings(): { codexSandbox: boolean } {
  return { codexSandbox: enabled };
}

async function persist(next: boolean): Promise<void> {
  enabled = next;
  const p = getPool();
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, JSON.stringify(next)],
  );
}

export async function setCodexSandbox(
  input: unknown,
): Promise<ReturnType<typeof getCodexSandboxSettings>> {
  if (typeof input !== "boolean") {
    throw Object.assign(new Error("codexSandbox must be a boolean"), {
      status: 400,
    });
  }
  await persist(input);
  return getCodexSandboxSettings();
}

/** Reset to default (sandbox ON). */
export async function clearCodexSandbox(): Promise<
  ReturnType<typeof getCodexSandboxSettings>
> {
  await persist(true);
  return getCodexSandboxSettings();
}
