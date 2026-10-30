/** Custom quick-prompt shortcuts for create/continue inputs (meta.quick_prompts). */
import { nanoid } from "nanoid";
import { getPool } from "./db.js";

const META_KEY = "quick_prompts";

export type QuickPrompt = {
  id: string;
  label: string;
  content: string;
};

let prompts: QuickPrompt[] = [];

function normalizeEntry(raw: unknown): QuickPrompt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  const content = typeof o.content === "string" ? o.content : "";
  if (!label || !content.trim()) return null;
  const id =
    typeof o.id === "string" && o.id.trim()
      ? o.id.trim().slice(0, 32)
      : nanoid(10);
  return { id, label: label.slice(0, 40), content };
}

/** Pure parse of meta.quick_prompts JSON (exported for tests). */
export function parseQuickPromptsJson(raw: string | null | undefined): QuickPrompt[] {
  if (!raw?.trim()) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: QuickPrompt[] = [];
    const seen = new Set<string>();
    for (const item of arr) {
      const entry = normalizeEntry(item);
      if (!entry) continue;
      if (seen.has(entry.id)) entry.id = nanoid(10);
      seen.add(entry.id);
      out.push(entry);
      if (out.length >= 50) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadQuickPrompts(): Promise<void> {
  const p = getPool();
  const res = await p.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = $1`,
    [META_KEY],
  );
  prompts = parseQuickPromptsJson(res.rows[0]?.value);
}

export function getQuickPromptSettings(): { quickPrompts: QuickPrompt[] } {
  return { quickPrompts: prompts.map((x) => ({ ...x })) };
}

async function persist(next: QuickPrompt[]): Promise<void> {
  prompts = next;
  const p = getPool();
  await p.query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, JSON.stringify(next)],
  );
}

/** Replace the full list. Empty/invalid items are dropped. */
export async function setQuickPrompts(
  input: unknown,
): Promise<ReturnType<typeof getQuickPromptSettings>> {
  if (!Array.isArray(input)) {
    throw Object.assign(new Error("quickPrompts must be an array"), {
      status: 400,
    });
  }
  const next: QuickPrompt[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const entry = normalizeEntry(item);
    if (!entry) continue;
    if (seen.has(entry.id)) entry.id = nanoid(10);
    seen.add(entry.id);
    next.push(entry);
    if (next.length >= 50) break;
  }
  await persist(next);
  return getQuickPromptSettings();
}

export async function clearQuickPrompts(): Promise<
  ReturnType<typeof getQuickPromptSettings>
> {
  await persist([]);
  return getQuickPromptSettings();
}

/** @internal test helper — does not persist. */
export function _resetQuickPromptsForTests(next: QuickPrompt[] = []): void {
  prompts = next.map((x) => ({ ...x }));
}
