/**
 * Commands the embedded dialer can run.
 * `board.register` advertises every name. Production UCloud 101 must be running
 * a relay that allowlists these names and the matching command types before
 * this process dials. An older relay rejects the whole register.
 */
export const BOARD_CAPABILITIES = [
  "archive.list",
  "archive.write",
  "workspace.settings",
  "board.settings",
] as const;

export type BoardCapability = (typeof BOARD_CAPABILITIES)[number];
