/**
 * Test double for a Drizzle query builder.
 *
 * Drizzle queries are fluent chains (`select().from().where().limit()`) that
 * run when awaited. `queryChain(run)` returns a chain whose every method
 * returns the chain itself, and which calls `run` (once per await) for its
 * result. Tests assert on `run`'s calls and results rather than on the
 * builder shape, so a reordered chain does not break them.
 *
 * `run` may return a value or a promise, or throw/reject to simulate a failed
 * query.
 */
// biome-ignore lint/suspicious/noExplicitAny: the chain stands in for every builder type
export function queryChain<T>(run: () => T | Promise<T>): any {
  // biome-ignore lint/suspicious/noExplicitAny: Proxy over a callable target
  const chain: any = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: T) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(run).then(resolve, reject);
      }
      return () => chain;
    },
  });
  return chain;
}
