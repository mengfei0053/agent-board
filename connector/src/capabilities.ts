/**
 * Keep in lockstep with `src/relay/capabilities.ts`.
 * Production 101 must allowlist these names before this process registers.
 */
export const BOARD_CAPABILITIES = [
  "archive.list",
  "archive.write",
  "workspace.settings",
  "board.settings",
] as const;
