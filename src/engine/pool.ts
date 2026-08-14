/**
 * Bounded-parallelism task pool.
 *
 * The cap is a promise to the user (`--concurrency 2` means two shells, never
 * three), so workers pull from a shared cursor instead of the list being sliced
 * into chunks: one slow target must not idle a worker that could already be
 * starting the next one.
 */

/** Runs `tasks` with at most `limit` in flight. Tasks must not reject. */
export async function runPool(tasks: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  if (tasks.length === 0) return;
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, tasks.length));

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const task = tasks[cursor++];
      if (!task) return;
      await task();
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
}
