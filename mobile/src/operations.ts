/** Stop admission before interrupting native work; await cleanup before attesting. */
export class Operations {
  closed = false;
  private pending = new Set<Promise<unknown>>();
  private stopping: Promise<void> | null = null;
  run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const task = work();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  stop(
    interrupt: () => Promise<void>,
    verify: () => Promise<void>,
  ): Promise<void> {
    if (this.stopping)
      return this.stopping.then(() => this.stop(interrupt, verify));
    this.closed = true;
    this.stopping = (async () => {
      let verified = false;
      try {
        // Even a failed native stop must drain admitted callbacks. Otherwise
        // an old prepare/ledger write can outlive a failed cleanup attempt.
        try {
          await interrupt();
        } finally {
          await Promise.allSettled([...this.pending]);
        }
        await verify();
        verified = true;
      } finally {
        // A failed cleanup cannot safely admit fresh recording/playback. A
        // later explicit stop may retry and reopen admission after verification.
        this.closed = !verified;
        this.stopping = null;
      }
    })();
    return this.stopping;
  }
}
