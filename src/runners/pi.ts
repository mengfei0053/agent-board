import { customAlphabet } from "nanoid";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";
import { mergeContinueWithoutSession } from "./promptForRun.js";

/** pi rejects session ids that do not start/end with an alphanumeric character. */
const PI_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const alnumSuffix = customAlphabet(ALNUM, 8);

export function isValidPiSessionId(id: string): boolean {
  return PI_SESSION_ID_RE.test(id);
}

/**
 * pi prints `{"type":"agent_settled",...}` once the run is done. Normally the
 * CLI exits right after; the board arms its settle watchdog on this line.
 */
export function isAgentSettledLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  if (trimmed.startsWith('{"type":"agent_settled"')) return true;
  try {
    return (JSON.parse(trimmed) as { type?: string }).type === "agent_settled";
  } catch {
    return false;
  }
}

/** `<taskId>-<suffix>` with punctuation-free edges, safe for pi's validator. */
export function makePiSessionId(taskId: string): string {
  const prefix = taskId.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
  return `${prefix || "task"}-${alnumSuffix()}`;
}

export type PiArgInput = {
  id: string;
  prompt: string;
  sessionId?: string;
  model?: string;
};

/** Pure CLI argv for pi (no spawn). */
export function buildPiArgs(
  task: PiArgInput,
  opts?: { continuePrompt?: string; freshSessionId?: string },
): { args: string[]; prompt: string; sessionId: string; assignSession: boolean } {
  const isContinue = Boolean(opts?.continuePrompt?.trim());
  // Legacy tasks may hold an id pi cannot load (e.g. leading "-"); treat it as absent.
  const storedSessionId = task.sessionId?.trim();
  const validSessionId =
    storedSessionId && isValidPiSessionId(storedSessionId) ? storedSessionId : undefined;
  const prompt =
    isContinue && !validSessionId
      ? mergeContinueWithoutSession(task.prompt, opts?.continuePrompt || "")
      : opts?.continuePrompt?.trim() || task.prompt;
  // A fresh run must not reuse task.id — that session file would keep the previous chat.
  const sessionId = validSessionId ?? (opts?.freshSessionId || makePiSessionId(task.id));
  // --session-id creates a missing session; continuation must fail instead of losing history.
  const sessionFlag = isContinue && validSessionId ? "--session" : "--session-id";
  const args = ["-p", "--mode", "json", sessionFlag, sessionId];
  if (task.model) args.push("--model", task.model);
  // "--" so a prompt starting with "-" is a message, not an unknown option.
  args.push("--", prompt);
  return {
    args,
    prompt,
    sessionId,
    assignSession: !validSessionId,
  };
}

export const piRunner: Runner = {
  start(task, hooks, opts) {
    const built = buildPiArgs(task, opts);
    if (built.assignSession) hooks.onStatus({ sessionId: built.sessionId });

    let status = task.status;
    return spawnLogged(resolveCliCommand("pi"), built.args, task.cwd, hooks, {
      cliKind: "pi",
      workspaceMcp: opts?.workspaceMcp,
      getStatus: () => status,
      settleLine: isAgentSettledLine,
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
          const ev = JSON.parse(line) as { type?: string; toolName?: string };
          if (!ev.type) return;
          h.onStatus({ lastEvent: ev.type });
          if (ev.type === "agent_start" || ev.type === "tool_execution_start") {
            if (ev.toolName === "ask_user_question") {
              status = "blocked";
              h.onStatus({ status: "blocked", lastEvent: ev.type });
            } else {
              status = "running";
              h.onStatus({ status: "running", lastEvent: ev.type });
            }
          } else if (ev.type === "agent_settled") {
            h.onStatus({ lastEvent: ev.type, summary: "agent settled" });
          }
        } catch {
          /* non-json line */
        }
      },
    });
  },
};
