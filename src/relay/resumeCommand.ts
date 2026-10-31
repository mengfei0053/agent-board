import { resolveCliCommand, type CliCommandKey } from "../cliPaths.js";

const RESUME_BIN: Record<string, CliCommandKey> = {
  pi: "pi",
  claude: "claude",
  cursor: "agent",
  devin: "devin",
  codex: "codex",
};

/** Same quoting as the web board's copyable resume command. */
export function shellQuote(value: unknown): string {
  const text = String(value ?? "");
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ready-to-copy shell command that resumes a task's CLI session outside the board.
 * Flags match `web/resumeCommand.js`. Null when there is no session id.
 */
export function resumeCommand(input: {
  kind?: string;
  sessionId?: string;
  cwd?: string;
  bin?: string;
}): string | null {
  const kind = input.kind ?? "";
  const key = RESUME_BIN[kind];
  const sessionId = String(input.sessionId ?? "").trim();
  if (!key || !sessionId) return null;
  const binName = (input.bin ?? resolveCliCommand(key)).trim();
  if (!binName) return null;

  const qBin = shellQuote(binName);
  const qId = shellQuote(sessionId);
  let cmd: string;
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
