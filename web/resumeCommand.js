/**
 * Ready-to-copy shell command that resumes a task's CLI session outside the board.
 *
 * Flags match what the runners already pass (interactive-friendly: no -p / json /
 * sandbox flags). Sources:
 * - pi: `--session-id` — src/runners/pi.ts `buildPiArgs`
 * - claude: `--resume` — src/runners/claude.ts `buildClaudeArgs`
 * - cursor: binary `agent` + `--resume` — src/runners/cursor.ts (`resolveCliCommand("agent")`)
 * - codex: `codex exec resume <id>` — src/runners/codex.ts (approval/json flags stay on the board)
 * - devin: `-r <id>` — src/runners/devin.ts. `-c` attaches the newest session in cwd
 *   and is intentionally not used once a session id is known.
 */

/** @typedef {"pi" | "claude" | "cursor" | "devin" | "codex"} ResumeKind */

/** Shown in the detail meta row when the task has no session id yet. */
export const NO_SESSION_LABEL = "尚无会话";

/** Default spawn names. Cursor's task kind uses the `agent` binary. */
export const RESUME_BIN = {
  pi: "pi",
  claude: "claude",
  cursor: "agent",
  devin: "devin",
  codex: "codex",
};

/** Settings / cliPaths key for a task kind (`cursor` → `agent`). */
export function cliKeyForKind(kind) {
  if (kind === "cursor") return "agent";
  return kind;
}

/**
 * POSIX single-quote when the value is not a plain token.
 * @param {unknown} value
 */
export function shellQuote(value) {
  const s = String(value ?? "");
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * @param {string | { effective?: string, override?: string, default?: string } | null | undefined} bin
 * @param {string} [kind]
 */
export function resolveResumeBin(kind, bin) {
  if (typeof bin === "string" && bin.trim()) return bin.trim();
  if (bin && typeof bin === "object") {
    const effective = String(bin.effective || "").trim();
    if (effective) return effective;
    const override = String(bin.override || "").trim();
    if (override) return override;
    const fallback = String(bin.default || "").trim();
    if (fallback) return fallback;
  }
  return RESUME_BIN[kind] || "";
}

/**
 * @param {{
 *   kind?: string,
 *   sessionId?: string,
 *   cwd?: string,
 *   bin?: string | { effective?: string, override?: string, default?: string },
 * }} [input]
 * @returns {string | null} null when there is no session id or the kind is unknown
 */
export function resumeCommand(input = {}) {
  const kind = input.kind;
  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId || !Object.prototype.hasOwnProperty.call(RESUME_BIN, kind)) return null;
  const binName = resolveResumeBin(kind, input.bin);
  if (!binName) return null;

  const qBin = shellQuote(binName);
  const qId = shellQuote(sessionId);
  let cmd;
  switch (kind) {
    case "pi":
      cmd = `${qBin} --session-id ${qId}`;
      break;
    case "claude":
    case "cursor":
      cmd = `${qBin} --resume ${qId}`;
      break;
    case "codex":
      cmd = `${qBin} exec resume ${qId}`;
      break;
    case "devin":
      cmd = `${qBin} -r ${qId}`;
      break;
    default:
      return null;
  }

  const cwd = String(input.cwd ?? "").trim();
  if (cwd) cmd = `cd ${shellQuote(cwd)} && ${cmd}`;
  return cmd;
}

/**
 * Command for the detail row, or a muted placeholder when it cannot be built.
 * @param {Parameters<typeof resumeCommand>[0]} [input]
 * @returns {{ command: string | null, emptyLabel: string | null }}
 */
export function resumeCommandView(input = {}) {
  const command = resumeCommand(input);
  if (command) return { command, emptyLabel: null };
  const hasSession = String(input.sessionId ?? "").trim().length > 0;
  return { command: null, emptyLabel: hasSession ? "—" : NO_SESSION_LABEL };
}
