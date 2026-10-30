import type { Workspace, WorkspaceSettings } from "./types.js";

export function normalizeWorkspaceSettings(
  raw: unknown,
): WorkspaceSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const out: WorkspaceSettings = {};

  if (typeof rec.systemPrompt === "string") {
    const s = rec.systemPrompt.trim();
    if (s) out.systemPrompt = s;
  }

  if (Array.isArray(rec.skills)) {
    const skills = rec.skills
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    if (skills.length) out.skills = skills;
  } else if (typeof rec.skills === "string") {
    const skills = rec.skills
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (skills.length) out.skills = skills;
  }

  if (typeof rec.mcp === "string") {
    const m = rec.mcp.trim();
    if (m) out.mcp = m;
  }

  return Object.keys(out).length ? out : undefined;
}

export function mergeWorkspaceSettings(
  prev: WorkspaceSettings | undefined,
  patch: WorkspaceSettings | undefined,
): WorkspaceSettings | undefined {
  if (patch === undefined) return prev;
  const next: WorkspaceSettings = { ...(prev || {}) };
  if ("systemPrompt" in patch) {
    const s = typeof patch.systemPrompt === "string" ? patch.systemPrompt.trim() : "";
    if (s) next.systemPrompt = s;
    else delete next.systemPrompt;
  }
  if ("skills" in patch) {
    const skills = (patch.skills || [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (skills.length) next.skills = skills;
    else delete next.skills;
  }
  if ("mcp" in patch) {
    const m = typeof patch.mcp === "string" ? patch.mcp.trim() : "";
    if (m) next.mcp = m;
    else delete next.mcp;
  }
  return Object.keys(next).length ? next : undefined;
}

/** Build prefix from workspace settings to prepend to the user prompt. */
export function buildWorkspacePromptPrefix(
  settings: WorkspaceSettings | undefined | null,
): string {
  if (!settings) return "";
  const parts: string[] = [];
  if (settings.systemPrompt?.trim()) {
    parts.push(`[工作区指令]\n${settings.systemPrompt.trim()}`);
  }
  if (settings.skills?.length) {
    parts.push(
      `[工作区 Skills]\n请优先使用/遵循以下 skills：\n` +
        settings.skills.map((s) => `- ${s}`).join("\n"),
    );
  }
  if (settings.mcp?.trim()) {
    parts.push(
      `[工作区 MCP]\n本工作区配置了以下 MCP（请在能力范围内使用相关工具；原生 MCP 注入尚未接线时以此为说明）：\n` +
        settings.mcp.trim(),
    );
  }
  return parts.join("\n\n");
}

/**
 * Apply workspace settings to the prompt sent to the runner.
 * - First start / continue without session: prepend space prompt + skills + mcp notes.
 * - Continue with an existing session: leave user prompt alone (context already has it).
 */
export function applyWorkspaceToPrompt(
  settings: WorkspaceSettings | undefined | null,
  userPrompt: string,
  opts?: { continueWithSession?: boolean },
): string {
  if (opts?.continueWithSession) return userPrompt;
  const prefix = buildWorkspacePromptPrefix(settings);
  if (!prefix) return userPrompt;
  const body = userPrompt.trim();
  return body ? `${prefix}\n\n---\n\n${body}` : prefix;
}

export function workspaceSettingsSummary(ws: Workspace | undefined): string {
  const s = ws?.settings;
  if (!s) return "";
  const bits: string[] = [];
  if (s.systemPrompt?.trim()) bits.push("提示词");
  if (s.skills?.length) bits.push(`skills×${s.skills.length}`);
  if (s.mcp?.trim()) bits.push("MCP");
  return bits.join(" · ");
}
