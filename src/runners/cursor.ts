import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner, RunnerHandle, RunnerHooks } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";
import { childProcessEnv } from "../proxyEnv.js";
import { spawnCollect } from "../spawnCollect.js";
import { mergeContinueWithoutSession } from "./promptForRun.js";

async function ensureCursorChatId(
  hooks: RunnerHooks,
  isStopped: () => boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const r = await spawnCollect(resolveCliCommand("agent"), ["create-chat"], {
      env: childProcessEnv("agent", { NO_COLOR: "1" }),
      timeoutMs: 20_000,
      signal,
    });
    if (isStopped()) return undefined;
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const id = lines[lines.length - 1];
    if (id && /^[0-9a-f-]{20,}$/i.test(id)) {
      hooks.onStatus({ sessionId: id });
      hooks.onLog(JSON.stringify({ type: "cursor_create_chat", sessionId: id }));
      return id;
    }
    hooks.onLog(
      JSON.stringify({
        type: "cursor_create_chat_failed",
        out: out.slice(0, 500),
        timedOut: r.timedOut,
      }),
    );
  } catch (err) {
    if (!isStopped()) {
      hooks.onLog(JSON.stringify({ type: "cursor_create_chat_error", error: String(err) }));
    }
  }
  return undefined;
}

export type CursorArgInput = {
  prompt: string;
  /** Session id known *before* create-chat / ensure */
  sessionId?: string;
  model?: string;
};

export type CursorBuildResult = {
  args: string[];
  prompt: string;
  resumeSessionId?: string;
  continueNewSession: boolean;
};

/**
 * Pure CLI argv for Cursor agent (no spawn / create-chat).
 * Branching uses `task.sessionId` (prior). Pass `resolvedSessionId` when
 * create-chat produced a fresh id for a run that had no prior session.
 */
export function buildCursorArgs(
  task: CursorArgInput,
  opts?: { continuePrompt?: string },
  resolvedSessionId?: string,
): CursorBuildResult {
  const isContinue = Boolean(opts?.continuePrompt);
  const args = ["-p", "--output-format", "stream-json", "--trust"];

  let prompt: string;
  let resumeSessionId: string | undefined;
  let continueNewSession = false;

  if (isContinue && task.sessionId) {
    prompt = opts?.continuePrompt?.trim() || task.prompt;
    resumeSessionId = task.sessionId;
    args.push("--resume", task.sessionId);
  } else if (isContinue && !task.sessionId) {
    // First round failed before session — do NOT --continue (wrong cwd session).
    prompt = mergeContinueWithoutSession(task.prompt, opts?.continuePrompt || "");
    continueNewSession = true;
    resumeSessionId = resolvedSessionId;
    if (resumeSessionId) args.push("--resume", resumeSessionId);
  } else {
    prompt = opts?.continuePrompt?.trim() || task.prompt;
    resumeSessionId = task.sessionId || resolvedSessionId;
    if (resumeSessionId) args.push("--resume", resumeSessionId);
  }

  if (task.model) args.push("--model", task.model);
  args.push(prompt);

  return { args, prompt, resumeSessionId, continueNewSession };
}

export const cursorRunner: Runner = {
  start(task, hooks, opts) {
    let stopped = false;
    let inner: RunnerHandle | null = null;
    const createChatAbort = new AbortController();
    const handle: RunnerHandle = {
      stop() {
        stopped = true;
        createChatAbort.abort();
        try {
          inner?.stop();
        } catch {
          /* ignore */
        }
      },
      stopAndWait: async (timeoutMs?: number) => {
        stopped = true;
        createChatAbort.abort();
        if (inner?.stopAndWait) await inner.stopAndWait(timeoutMs);
        else inner?.stop();
      },
    };

    const priorSessionId = task.sessionId;
    const launch = (resolved: string | undefined) => {
      if (stopped) return;
      if (resolved) task.sessionId = resolved;
      const built = buildCursorArgs(
        { prompt: task.prompt, sessionId: priorSessionId, model: task.model },
        opts,
        resolved,
      );
      if (built.continueNewSession) {
        hooks.onLog(
          JSON.stringify({
            type: "continue_new_session",
            kind: "cursor",
            note: "no sessionId; fresh chat with original prompt plus continue instruction",
            sessionId: built.resumeSessionId || null,
          }),
        );
      }
      let status = task.status;
      inner = spawnLogged(resolveCliCommand("agent"), built.args, task.cwd, hooks, {
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
      if (inner.pid) handle.pid = inner.pid;
    };

    const failLaunch = (err: unknown) => {
      if (stopped) return;
      const error = err instanceof Error ? err.message : String(err);
      try {
        hooks.onStatus({
          status: "failed",
          error,
          endedAt: new Date().toISOString(),
          lastEvent: "launch_failed",
        });
      } catch {
        /* the caller still needs this rejection handled */
      }
    };

    const launchSafe = (resolved: string | undefined) => {
      try {
        launch(resolved);
      } catch (err) {
        failLaunch(err);
      }
    };

    if (priorSessionId) {
      launchSafe(undefined);
    } else {
      void ensureCursorChatId(hooks, () => stopped, createChatAbort.signal)
        .then((id) => {
          if (!stopped) launchSafe(id);
        })
        .catch((err) => failLaunch(err));
    }
    return handle;
  },
};
