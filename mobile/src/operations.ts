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
      try {
        await interrupt();
        await Promise.allSettled([...this.pending]);
        await verify();
      } finally {
        this.closed = false;
        this.stopping = null;
      }
    })();
    return this.stopping;
  }
}
