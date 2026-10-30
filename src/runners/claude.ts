import { randomUUID } from "node:crypto";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";

export type ClaudeArgInput = {
  prompt: string;
  sessionId?: string;
  model?: string;
};

export type ClaudeBuildResult = {
  args: string[];
  prompt: string;
  /** Session id written onto the task / reported via onStatus when new */
  sessionId: string;
  /** True when we assigned a fresh session id this call */
  assignedSession: boolean;
  /** Continue without prior session — log continue_new_session */
  continueNewSession: boolean;
};

/**
 * Pure CLI argv for Claude Code (no spawn).
 * @param newSessionId factory for tests (default randomUUID)
 */
export function buildClaudeArgs(
  task: ClaudeArgInput,
  opts?: { continuePrompt?: string },
  newSessionId: () => string = () => randomUUID(),
): ClaudeBuildResult {
  const isContinue = Boolean(opts?.continuePrompt);
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  let prompt: string;
  let sessionId: string;
  let assignedSession = false;
  let continueNewSession = false;

  if (isContinue && task.sessionId) {
    prompt = opts?.continuePrompt?.trim() || task.prompt;
    sessionId = task.sessionId;
    args.push("--resume", task.sessionId);
  } else if (isContinue && !task.sessionId) {
    // First round failed before session — do NOT --continue (wrong cwd session).
    prompt = task.prompt;
    sessionId = newSessionId();
    assignedSession = true;
    continueNewSession = true;
    args.push("--session-id", sessionId);
  } else {
    prompt = opts?.continuePrompt?.trim() || task.prompt;
    sessionId = task.sessionId || newSessionId();
    if (!task.sessionId) assignedSession = true;
    args.push("--session-id", sessionId);
  }

  if (task.model) args.push("--model", task.model);
  args.push(prompt);

  return { args, prompt, sessionId, assignedSession, continueNewSession };
}

export const claudeRunner: Runner = {
  start(task, hooks, opts) {
    const built = buildClaudeArgs(task, opts);
    if (built.assignedSession) {
      task.sessionId = built.sessionId;
      hooks.onStatus({ sessionId: built.sessionId });
    } else {
      task.sessionId = built.sessionId;
    }
    if (built.continueNewSession) {
      hooks.onLog(
        JSON.stringify({
          type: "continue_new_session",
          kind: "claude",
          note: "no sessionId; starting fresh session with task.prompt (not --continue)",
          sessionId: built.sessionId,
        }),
      );
    }

    let status = task.status;
    return spawnLogged(resolveCliCommand("claude"), built.args, task.cwd, hooks, {
      cliKind: "claude",
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
          const ev = JSON.parse(line) as { type?: string; subtype?: string };
          const label = [ev.type, ev.subtype].filter(Boolean).join(":");
          if (label) {
            status = "running";
            h.onStatus({ status: "running", lastEvent: label });
          }
        } catch {
          /* plain text */
        }
      },
    });
  },
};
