/**
 * Runs tasks one at a time per key, in arrival order.
 * Two pushes to the same pull request in quick succession must not produce two reviews
 * racing each other; the second run sees the first run's review and the new head SHA.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    // tailsには失敗を握りつぶした版を入れるので、前のタスクが失敗しても後続は実行される
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
