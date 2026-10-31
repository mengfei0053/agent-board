/**
 * Commands the embedded dialer can run.
 * `board.register` advertises every name. The public relay must allowlist the
 * same names before this process dials production; unknown names reject register.
 * Command-type forwarding (`cmd.workspace.get` and the rest) is still wave 2.
 */
export const BOARD_CAPABILITIES = [
  "archive.list",
  "archive.write",
  "workspace.settings",
  "board.settings",
] as const;

export type BoardCapability = (typeof BOARD_CAPABILITIES)[number];
