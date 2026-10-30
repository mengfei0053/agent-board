import type { AgentKind } from "../types.js";
import type { Runner } from "./types.js";
import { piRunner } from "./pi.js";
import { claudeRunner } from "./claude.js";
import { cursorRunner } from "./cursor.js";
import { devinRunner } from "./devin.js";
import { codexRunner } from "./codex.js";

export const runners: Record<AgentKind, Runner> = {
  pi: piRunner,
  claude: claudeRunner,
  cursor: cursorRunner,
  devin: devinRunner,
  codex: codexRunner,
};
