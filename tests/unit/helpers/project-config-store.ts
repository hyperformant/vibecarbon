// biome-ignore lint/suspicious/noExplicitAny: tests read deep, untyped JSON out of the writes
type Config = Record<string, any>;

/**
 * An in-memory `.vibecarbon.json` behind a stand-in for `updateProjectConfig`
 * (src/lib/config.js), for tests that mock lib/config.js instead of writing a
 * real file.
 *
 * It keeps the real contract: the mutator gets a fresh copy of what is "on
 * disk" now, may change it in place or return a replacement, and a no-op
 * writes nothing. `writes` lists each config as written, in order.
 *
 * `disk` may be set to an object the test keeps mutating (a ctx.projectConfig):
 * it is copied at each call, so the mutator always sees its current state.
 */
export function projectConfigStore(initial?: Record<string, unknown>) {
  const state: { disk: Config | null | undefined; writes: Config[] } = {
    disk: initial,
    writes: [],
  };
  const updateProjectConfig = (mutator: (config: Config) => unknown) => {
    const current = structuredClone(state.disk ?? {});
    const unchanged = JSON.stringify(current);
    const returned = mutator(current) as Config | undefined;
    const next = returned ?? current;
    if (JSON.stringify(next) !== unchanged) {
      state.disk = structuredClone(next);
      state.writes.push(structuredClone(next));
    }
    return next;
  };
  return {
    state,
    updateProjectConfig,
    /** The last config written, or undefined when nothing was. */
    lastWrite: () => state.writes.at(-1),
    reset(disk?: Record<string, unknown> | null) {
      state.disk = disk;
      state.writes = [];
    },
  };
}
