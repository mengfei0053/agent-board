/** Serializes settings read-modify-write so concurrent partial patches merge. */
let tail: Promise<unknown> = Promise.resolve();
/** First locked section awaits this once. Tests use it to force overlap. */
let barrier: Promise<void> | null = null;

export function setSettingsBarrierForTests(p: Promise<void> | null): void {
  barrier = p;
}

async function waitBarrier(): Promise<void> {
  const pending = barrier;
  if (!pending) return;
  barrier = null;
  await pending;
}

export function withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    await waitBarrier();
    return fn();
  }, async () => {
    await waitBarrier();
    return fn();
  });
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
