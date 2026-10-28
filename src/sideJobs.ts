import type { SideJob, SideJobKind, SideJobStatus } from "./types.js";

export type SideJobUpdate = Partial<SideJob> & { id: string };

const AGENT_TOOLS = new Set([
  "agent",
  "task",
  "taskcreate",
  "taskupdate",
  "taskoutput",
  "tasklist",
  "taskstop",
  "taskget",
  "subagent",
]);

function lower(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function isBackgroundInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const o = input as Record<string, unknown>;
  if (o.run_in_background === true || o.runInBackground === true || o.background === true) {
    return true;
  }
  if (o.block_until_ms === 0 || o.blockUntilMs === 0) return true;
  const cmd = typeof o.command === "string" ? o.command : typeof o.cmd === "string" ? o.cmd : "";
  if (/\b(monitor|nohup|&\s*$)/i.test(cmd) && /background|monitor/i.test(JSON.stringify(o))) {
    return true;
  }
  return false;
}

function classifyTool(name: string, input?: unknown): SideJobKind | null {
  const n = name.toLowerCase().trim();
  if (!n) return null;
  if (n.includes("monitor") || n === "await" || n === "wait" || n === "awaittool") return "monitor";
  if (n.includes("subagent") || n === "agent") return "agent";
  if (AGENT_TOOLS.has(n) || n.startsWith("task")) return "task";
  if (n.includes("background")) return "background";
  if (n === "bash" || n === "shell" || n === "bash_tool" || n === "run_terminal_cmd") {
    return isBackgroundInput(input) ? "background" : null;
  }
  // Claude MCP / generic: name contains Agent
  if (/\bagent\b/i.test(name)) return "agent";
  return null;
}

function titleFromInput(toolName: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of [
      "description",
      "title",
      "prompt",
      "query",
      "goal",
      "name",
      "command",
      "cmd",
      "message",
    ]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        return v.trim().slice(0, 120);
      }
    }
    if (typeof o.subagent_type === "string") {
      return `${toolName} (${o.subagent_type})`;
    }
  }
  return toolName;
}

function summaryFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof o.subagent_type === "string") bits.push(`type=${o.subagent_type}`);
  if (typeof o.model === "string") bits.push(`model=${o.model}`);
  if (o.run_in_background === true || o.background === true) bits.push("background");
  return bits.length ? bits.join(" · ") : undefined;
}

function statusFromResult(result: unknown, isError?: boolean): SideJobStatus {
  if (isError === true) return "failed";
  if (result && typeof result === "object") {
    const o = result as Record<string, unknown>;
    if (o.is_error === true || o.isError === true) return "failed";
    const st = lower(o.status);
    if (["failed", "error", "cancelled", "canceled"].includes(st)) return "failed";
    if (["stopped", "interrupted"].includes(st)) return "stopped";
    if (["success", "succeeded", "completed", "ok", "done"].includes(st)) return "succeeded";
    if (["running", "in_progress", "pending"].includes(st)) return "running";
  }
  if (typeof result === "string" && /error|failed/i.test(result.slice(0, 200))) return "failed";
  return "succeeded";
}

function pushUpdate(out: SideJobUpdate[], u: SideJobUpdate) {
  out.push(u);
}

function handleToolStart(
  out: SideJobUpdate[],
  opts: {
    id: string;
    toolName: string;
    input?: unknown;
    at: string;
  },
) {
  const kind = classifyTool(opts.toolName, opts.input);
  if (!kind) return;
  pushUpdate(out, {
    id: opts.id,
    kind,
    toolName: opts.toolName,
    title: titleFromInput(opts.toolName, opts.input),
    summary: summaryFromInput(opts.input),
    status: "running",
    startedAt: opts.at,
  });
}

function handleToolEnd(
  out: SideJobUpdate[],
  opts: {
    id: string;
    toolName?: string;
    result?: unknown;
    isError?: boolean;
    at: string;
  },
) {
  const status = statusFromResult(opts.result, opts.isError);
  const patch: SideJobUpdate = {
    id: opts.id,
    status,
    endedAt: opts.at,
  };
  if (opts.toolName) patch.toolName = opts.toolName;
  // If we only see the end event, still classify when possible
  if (opts.toolName) {
    const kind = classifyTool(opts.toolName, undefined);
    if (kind) {
      patch.kind = kind;
      patch.title = opts.toolName;
    }
  }
  pushUpdate(out, patch);
}

function walkContentBlocks(blocks: unknown, at: string, out: SideJobUpdate[]) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    const btype = lower(block.type);
    if (btype === "tool_use" || btype === "tool-call" || btype === "tool_call") {
      const name = String(block.name || block.toolName || "");
      const id = String(block.id || block.tool_use_id || block.toolUseId || `${name}-${at}`);
      handleToolStart(out, { id, toolName: name, input: block.input ?? block.arguments ?? block.args, at });
    } else if (btype === "tool_result" || btype === "tool-result") {
      const id = String(block.tool_use_id || block.toolUseId || block.id || "");
      if (!id) continue;
      handleToolEnd(out, {
        id,
        toolName: typeof block.name === "string" ? block.name : undefined,
        result: block.content ?? block.output ?? block.result,
        isError: block.is_error === true || block.isError === true,
        at,
      });
    }
  }
}

/**
 * Extract side-job upserts from one agent event-stream line.
 * Never throws; returns [] when nothing relevant.
 */
export function sideJobsFromLogLine(line: string, at: string): SideJobUpdate[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return [];
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const out: SideJobUpdate[] = [];
  const type = lower(ev.type);
  const subtype = lower(ev.subtype);

  try {
    // pi: tool_execution_start / tool_execution_end
    if (type === "tool_execution_start" || type === "tool_start") {
      const toolName = String(ev.toolName || ev.name || ev.tool || "");
      const id = String(ev.toolCallId || ev.tool_call_id || ev.id || `${toolName}-${at}`);
      handleToolStart(out, {
        id,
        toolName,
        input: ev.args ?? ev.arguments ?? ev.input ?? ev.parameters,
        at,
      });
    } else if (type === "tool_execution_end" || type === "tool_end" || type === "tool_execution_error") {
      const toolName = String(ev.toolName || ev.name || ev.tool || "");
      const id = String(ev.toolCallId || ev.tool_call_id || ev.id || `${toolName}-${at}`);
      handleToolEnd(out, {
        id,
        toolName: toolName || undefined,
        result: ev.result ?? ev.output ?? ev.error,
        isError: type.includes("error") || ev.isError === true,
        at,
      });
    }

    // Claude / Cursor stream-json: assistant / user messages with content blocks
    if (type === "assistant" || type === "user" || type === "message") {
      const message = (ev.message && typeof ev.message === "object" ? ev.message : ev) as Record<
        string,
        unknown
      >;
      walkContentBlocks(message.content, at, out);
      if (Array.isArray(ev.content)) walkContentBlocks(ev.content, at, out);
    }

    // content_block_start with tool_use
    if (type === "content_block_start") {
      const cb = ev.content_block;
      if (cb && typeof cb === "object") walkContentBlocks([cb], at, out);
    }

    // Claude Code task / monitor progress notifications
    if (
      type === "system" &&
      (subtype.includes("task") || subtype.includes("hook") || subtype.includes("monitor"))
    ) {
      const data = (ev.data && typeof ev.data === "object" ? ev.data : ev) as Record<string, unknown>;
      const toolName = String(data.tool_name || data.toolName || data.name || subtype || "task");
      const kind = classifyTool(toolName, data) || (subtype.includes("monitor") ? "monitor" : "task");
      const id = String(data.task_id || data.taskId || data.id || data.tool_use_id || `${toolName}-${at}`);
      const st = lower(data.status);
      const status: SideJobStatus =
        st === "running" || st === "in_progress"
          ? "running"
          : st === "failed" || st === "error"
            ? "failed"
            : st === "stopped"
              ? "stopped"
              : st === "completed" || st === "success" || st === "succeeded"
                ? "succeeded"
                : "running";
      pushUpdate(out, {
        id,
        kind,
        toolName,
        title: titleFromInput(toolName, data),
        summary: summaryFromInput(data) || (subtype ? `system:${subtype}` : undefined),
        status,
        startedAt: status === "running" ? at : undefined,
        endedAt: status === "running" ? undefined : at,
      });
    }

    // Generic nested tool fields (cursor / others)
    if (ev.tool_use && typeof ev.tool_use === "object") {
      walkContentBlocks([{ type: "tool_use", ...(ev.tool_use as object) }], at, out);
    }
    if (Array.isArray(ev.tools)) {
      for (const tool of ev.tools) {
        if (tool && typeof tool === "object") {
          const o = tool as Record<string, unknown>;
          walkContentBlocks([{ type: "tool_use", name: o.name, id: o.id, input: o.input }], at, out);
        }
      }
    }
  } catch {
    return out;
  }

  // Drop updates that never got a kind (end-only for non-side tools)
  return out.filter((u) => u.kind || u.status);
}

export function mergeSideJobs(
  existing: SideJob[] | undefined,
  updates: SideJobUpdate[],
): SideJob[] | null {
  if (!updates.length) return null;
  const map = new Map<string, SideJob>();
  for (const j of existing || []) map.set(j.id, { ...j });

  let changed = false;
  for (const u of updates) {
    if (!u.id) continue;
    const prev = map.get(u.id);
    if (!prev) {
      // Need enough to create
      if (!u.kind || !u.title) {
        // end-only without prior start: skip unless kind was inferred
        if (!u.kind) continue;
        map.set(u.id, {
          id: u.id,
          kind: u.kind,
          title: u.title || u.toolName || u.id,
          summary: u.summary,
          status: u.status || "unknown",
          toolName: u.toolName,
          startedAt: u.startedAt,
          endedAt: u.endedAt,
        });
        changed = true;
        continue;
      }
      map.set(u.id, {
        id: u.id,
        kind: u.kind,
        title: u.title,
        summary: u.summary,
        status: u.status || "running",
        toolName: u.toolName,
        startedAt: u.startedAt,
        endedAt: u.endedAt,
      });
      changed = true;
      continue;
    }
    const next: SideJob = {
      ...prev,
      kind: prev.kind || u.kind || "other",
      title: prev.title || u.title || prev.toolName || u.toolName || u.id,
      summary: u.summary !== undefined ? u.summary : prev.summary,
      status: u.status || prev.status,
      toolName: prev.toolName || u.toolName,
      startedAt: prev.startedAt || u.startedAt,
      endedAt: u.endedAt ?? prev.endedAt,
    };
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      map.set(u.id, next);
      changed = true;
    }
  }

  if (!changed) return null;
  return [...map.values()].sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
}

/** When parent task ends, close still-running side jobs. */
export function finalizeRunningSideJobs(
  existing: SideJob[] | undefined,
  endedAt: string,
  terminal: SideJobStatus = "stopped",
): SideJob[] | null {
  if (!existing?.length) return null;
  let changed = false;
  const next = existing.map((j) => {
    if (j.status !== "running" && j.status !== "unknown") return j;
    changed = true;
    return { ...j, status: terminal, endedAt: j.endedAt || endedAt };
  });
  return changed ? next : null;
}
