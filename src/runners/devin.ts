import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Runner, RunnerHooks } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";
import { childProcessEnv } from "../proxyEnv.js";

/** Best-effort: newest session in cwd via `devin list --format json`. */
function latestDevinSession(cwd: string, hooks: RunnerHooks): string | undefined {
  try {
    const r = spawnSync(resolveCliCommand("devin"), ["list", "--format", "json"], {
      cwd,
      encoding: "utf8",
      env: childProcessEnv({ NO_COLOR: "1", FORCE_COLOR: "0" }),
      timeout: 15000,
    });
    const raw = `${r.stdout || ""}\n${r.stderr || ""}`;
    const start = raw.indexOf("[");
    if (start < 0) {
      hooks.onLog(
        JSON.stringify({
          type: "devin_list_failed",
          out: raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim().slice(0, 400),
        }),
      );
      return undefined;
    }
    const arr = JSON.parse(raw.slice(start)) as Array<{ id?: string }>;
    const id = arr?.[0]?.id;
    if (typeof id === "string" && id.trim()) return id.trim();
  } catch (err) {
    hooks.onLog(JSON.stringify({ type: "devin_list_error", error: String(err) }));
  }
  return undefined;
}

/** Fallback when `devin list` is unavailable: read local sessions.db. */
function latestSessionFromDb(cwd: string): string | undefined {
  try {
    const dbPath = join(homedir(), ".local/share/devin/cli/sessions.db");
    if (!existsSync(dbPath)) return undefined;
    const r = spawnSync(
      "python3",
      [
        "-c",
        "import sqlite3,sys\n"
          + "con=sqlite3.connect(sys.argv[1])\n"
          + "row=con.execute('SELECT id FROM sessions WHERE working_directory=? ORDER BY last_activity_at DESC LIMIT 1', (sys.argv[2],)).fetchone()\n"
          + "print(row[0] if row else '')\n",
        dbPath,
        cwd,
      ],
      { encoding: "utf8", timeout: 5000, env: childProcessEnv() },
    );
    const id = (r.stdout || "").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function captureSession(
  cwd: string,
  task: { sessionId?: string },
  hooks: RunnerHooks,
) {
  const sid = latestDevinSession(cwd, hooks) || latestSessionFromDb(cwd);
  if (sid && sid !== task.sessionId) {
    task.sessionId = sid;
    hooks.onStatus({ sessionId: sid });
    hooks.onLog(JSON.stringify({ type: "devin_session", sessionId: sid }));
  }
}

export const devinRunner: Runner = {
  start(task, hooks, opts) {
    const prompt = opts?.continuePrompt?.trim() || task.prompt;
    const isContinue = Boolean(opts?.continuePrompt);
    // Non-interactive board: auto-approve workspace edits; skip trust prompt.
    const args = [
      "-p",
      "--permission-mode",
      "accept-edits",
      "--respect-workspace-trust",
      "false",
    ];

    let promptForRun = prompt;
    if (isContinue) {
      if (task.sessionId) {
        args.push("-r", task.sessionId);
      } else {
        // First round failed before session — do NOT -c (wrong cwd session).
        promptForRun = task.prompt;
        hooks.onLog(
          JSON.stringify({
            type: "continue_new_session",
            kind: "devin",
            note: "no sessionId; starting fresh run with task.prompt (not -c)",
          }),
        );
      }
    }

    if (task.model) args.push("--model", task.model);
    args.push("--", promptForRun);

    let status = task.status;
    let sawAgentError = false;

    return spawnLogged(
      resolveCliCommand("devin"),
      args,
      task.cwd,
      {
        onStatus: (p) => {
          if (
            p.status === "succeeded" ||
            p.status === "failed" ||
            p.status === "stopped"
          ) {
            try {
              captureSession(task.cwd, task, hooks);
            } catch {
              /* ignore */
            }
            if (sawAgentError && p.status === "succeeded") {
              status = "failed";
              hooks.onStatus({
                ...p,
                status: "failed",
                error: p.error || "Devin agent error (see logs)",
              });
              return;
            }
          }
          if (p.status) status = p.status;
          hooks.onStatus(p);
        },
        onLog: hooks.onLog,
      },
      {
        getStatus: () => status,
        classifyLine: (line, h) => {
          const trimmed = line.trim();
          // Devin sometimes prints Agent error then still exits; mark flag only —
          // wait for process close so full stdout is logged before terminal status.
          if (/^Error:\s*Agent error/i.test(trimmed)) {
            sawAgentError = true;
            h.onStatus({
              lastEvent: "agent_error",
              error: trimmed.slice(0, 300),
            });
            if (status !== "running" && status !== "stopped") {
              status = "running";
              h.onStatus({ status: "running", lastEvent: "agent_error" });
            }
            return;
          }
          if (trimmed && !trimmed.startsWith("{")) {
            if (status !== "running" && status !== "failed" && status !== "stopped") {
              status = "running";
              h.onStatus({ status: "running", lastEvent: "stdout" });
            }
          }
        },
      },
    );
  },
};
