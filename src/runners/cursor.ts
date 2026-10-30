import { spawnSync } from "node:child_process";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";
import { childProcessEnv } from "../proxyEnv.js";

function ensureCursorChatId(task: { sessionId?: string }, hooks: { onStatus: (p: { sessionId: string }) => void; onLog: (line: string) => void }): string | undefined {
  if (task.sessionId) return task.sessionId;
  try {
    const r = spawnSync(resolveCliCommand("agent"), ["create-chat"], {
      encoding: "utf8",
      env: childProcessEnv("agent", { NO_COLOR: "1" }),
      timeout: 20000,
    });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const id = lines[lines.length - 1];
    if (id && /^[0-9a-f-]{20,}$/i.test(id)) {
      hooks.onStatus({ sessionId: id });
      hooks.onLog(JSON.stringify({ type: "cursor_create_chat", sessionId: id }));
      return id;
    }
    hooks.onLog(JSON.stringify({ type: "cursor_create_chat_failed", out: out.slice(0, 500) }));
  } catch (err) {
    hooks.onLog(JSON.stringify({ type: "cursor_create_chat_error", error: String(err) }));
  }
  return undefined;
}

export const cursorRunner: Runner = {
  start(task, hooks, opts) {
    const isContinue = Boolean(opts?.continuePrompt);
    // --trust: non-interactive board must not hang on workspace trust prompt
    const args = ["-p", "--output-format", "stream-json", "--trust"];

    let sessionId = task.sessionId;
    let prompt: string;

    if (isContinue && sessionId) {
      prompt = opts?.continuePrompt?.trim() || task.prompt;
      args.push("--resume", sessionId);
    } else if (isContinue && !sessionId) {
      // First round failed before session — do NOT --continue (wrong cwd session).
      prompt = task.prompt;
      sessionId = ensureCursorChatId(task, hooks) || sessionId;
      if (sessionId) {
        task.sessionId = sessionId;
        args.push("--resume", sessionId);
      }
      hooks.onLog(
        JSON.stringify({
          type: "continue_new_session",
          kind: "cursor",
          note: "no sessionId; starting fresh chat with task.prompt (not --continue)",
          sessionId: sessionId || null,
        }),
      );
    } else {
      prompt = opts?.continuePrompt?.trim() || task.prompt;
      sessionId = ensureCursorChatId(task, hooks) || sessionId;
      if (sessionId) {
        task.sessionId = sessionId;
        args.push("--resume", sessionId);
      }
    }

    if (task.model) args.push("--model", task.model);
    args.push(prompt);

    let status = task.status;
    return spawnLogged(resolveCliCommand("agent"), args, task.cwd, hooks, {
      cliKind: "agent",
      getStatus: () => status,
      classifyLine: (line, h) => {
        const detected = modelFromJsonLine(line);
        if (detected && !task.model) {
          task.model = detected;
          h.onStatus({ model: detected });
        }
        const sid = sessionFromJsonLine(line);
        if (sid && sid !== task.sessionId) {
          task.sessionId = sid;
          h.onStatus({ sessionId: sid });
        }
        try {
          const ev = JSON.parse(line) as { type?: string };
          if (ev.type) {
            status = "running";
            h.onStatus({ status: "running", lastEvent: ev.type });
          }
        } catch {
          /* plain */
        }
      },
    });
  },
};
