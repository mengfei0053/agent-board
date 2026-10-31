/**
 * Bounds for the embedded relay dialer. Overflow closes the socket and
 * reconnects; it must not crash the board process.
 */
export const RELAY_LIMITS = {
  /** Pre-session inbound relay frames buffered before the session can take commands. */
  maxPendingFrames: 32,
  /**
   * Live `cmd.*` jobs waiting on the session serial tail, including the one
   * currently running. The next frame is rejected and the socket is closed.
   */
  maxLiveCommands: 32,
  /** Max inbound or outbound frame size in bytes. */
  maxFrameBytes: 256 * 1024,
  /** Close and reconnect when `ws.bufferedAmount` exceeds this. */
  maxOutboundBufferedBytes: 2 * 1024 * 1024,
  /** Board events queued during snapshot enrich or while the serial tail is busy. */
  maxBusBuffer: 200,
  /** Workspaces included in `evt.snapshot` (phone rejects lists longer than this). */
  maxWorkspaces: 50,
  /** Tasks included in one snapshot, newest `updatedAt` first when capped. */
  maxSnapshotTasks: 500,
  /** `evt.log` line length before truncation. */
  maxLogChars: 2_000,
  /** Successful create results remembered for the life of the dialer. */
  idempotencyCache: 500,
  /** WebSocket handshake budget. */
  openTimeoutMs: 8_000,
  /** Wait for `board.register` ack. */
  registerTimeoutMs: 8_000,
} as const;
