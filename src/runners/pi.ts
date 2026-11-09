import { customAlphabet } from "nanoid";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner, RunnerHandle } from "./types.js";
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
  thinkingEffort?: string;
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
  if (task.thinkingEffort) args.push("--thinking", task.thinkingEffort);
  // "--" so a prompt starting with "-" is a message, not an unknown option.
  args.push("--", prompt);
  return {
    args,
    prompt,
    sessionId,
    assignSession: !validSessionId,
  };
}

/** Pure CLI argv for pi in RPC mode (prompts sent over stdin). */
export function buildPiRpcArgs(
  task: PiArgInput,
  opts?: { continuePrompt?: string; freshSessionId?: string },
): { args: string[]; prompt: string; sessionId: string; assignSession: boolean } {
  const built = buildPiArgs(task, opts);
  const isContinue = Boolean(opts?.continuePrompt?.trim());
  const storedSessionId = task.sessionId?.trim();
  const validSessionId =
    storedSessionId && isValidPiSessionId(storedSessionId) ? storedSessionId : undefined;
  const sessionFlag = isContinue && validSessionId ? "--session" : "--session-id";
  const args = ["--mode", "rpc", sessionFlag, built.sessionId];
  if (task.model) args.push("--model", task.model);
  if (task.thinkingEffort) args.push("--thinking", task.thinkingEffort);
  return {
    args,
    prompt: built.prompt,
    sessionId: built.sessionId,
    assignSession: built.assignSession,
  };
}

export const piRunner: Runner = {
  start(task, hooks, opts) {
    const built = buildPiRpcArgs(task, opts);
    if (built.assignSession) hooks.onStatus({ sessionId: built.sessionId });

    let status = task.status;
    let steerSeq = 0;
    const pendingSteerIds = new Set<string>();
    let runsStarted = 0;
    let runsSettled = 0;
    let stdinClosed = false;
    let handleRef: RunnerHandle | undefined;

    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      handleRef?.endStdin?.();
    };

    const handle = spawnLogged(resolveCliCommand("pi"), built.args, task.cwd, hooks, {
      cliKind: "pi",
      stdinPipe: true,
      workspaceMcp: opts?.workspaceMcp,
      getStatus: () => status,
      settleLine: (line) =>
        isAgentSettledLine(line) &&
        pendingSteerIds.size === 0 &&
        runsSettled >= Math.max(1, runsStarted),
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
          const ev = JSON.parse(line) as {
            id?: string;
            type?: string;
            command?: string;
            success?: boolean;
            error?: string;
            data?: {
              disposition?: string;
              sessionId?: string;
              model?: { provider?: string; id?: string };
            };
            method?: string;
            toolName?: string;
          };
          if (!ev.type) return;
          if (ev.type === "extension_ui_request") {
            if (
              typeof ev.id === "string" &&
              (ev.method === "select" ||
                ev.method === "confirm" ||
                ev.method === "input" ||
                ev.method === "editor")
            ) {
              handleRef?.writeStdin?.(
                `${JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true })}\n`,
              );
            }
            return;
          }
          if (ev.type === "response") {
            if (ev.command === "get_state" && ev.success && ev.data) {
              if (ev.data.sessionId && ev.data.sessionId !== task.sessionId) {
                task.sessionId = ev.data.sessionId;
                h.onStatus({ sessionId: ev.data.sessionId });
              }
              const m = ev.data.model;
              const fullModel =
                m && typeof m === "object" && m.id
                  ? m.provider
                    ? `${m.provider}/${m.id}`
                    : m.id
                  : undefined;
              if (fullModel && !task.model) {
                task.model = fullModel;
                h.onStatus({ model: fullModel });
              }
            }
            if (ev.command === "prompt") {
              if (typeof ev.id === "string") {
                pendingSteerIds.delete(ev.id);
              }
              if (ev.success === false) {
                if (ev.id === "init") {
                  status = "failed";
                  h.onStatus({
                    status: "failed",
                    error: ev.error || "pi prompt failed",
                    lastEvent: "prompt_error",
                  });
                  closeStdin();
                } else if (
                  pendingSteerIds.size === 0 &&
                  runsSettled >= Math.max(1, runsStarted)
                ) {
                  closeStdin();
                }
                return;
              }
              const disp = ev.data?.disposition;
              if (disp === "started") {
                runsStarted += 1;
              } else if (
                pendingSteerIds.size === 0 &&
                runsSettled >= Math.max(1, runsStarted)
              ) {
                closeStdin();
              } else if (ev.id === "init" && disp === "handled" && pendingSteerIds.size === 0) {
                closeStdin();
              }
            }
            return;
          }
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
            runsSettled += 1;
            h.onStatus({ lastEvent: ev.type, summary: "agent settled" });
            if (pendingSteerIds.size === 0 && runsSettled >= Math.max(1, runsStarted)) {
              closeStdin();
            }
          }
        } catch {
          /* non-json line */
        }
      },
    });
    handleRef = handle;
    handle.writeStdin?.(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
    handle.writeStdin?.(
      `${JSON.stringify({ id: "init", type: "prompt", message: built.prompt })}\n`,
    );
    handle.steer = (steerPrompt: string): boolean => {
      const trimmed = steerPrompt.trim();
      if (!trimmed || stdinClosed) return false;
      const reqId = `steer_${++steerSeq}`;
      pendingSteerIds.add(reqId);
      const ok = Boolean(
        handle.writeStdin?.(
          `${JSON.stringify({
            id: reqId,
            type: "prompt",
            message: trimmed,
            streamingBehavior: "steer",
          })}\n`,
        ),
      );
      if (!ok) pendingSteerIds.delete(reqId);
      return ok;
    };
    return handle;
  },
};
