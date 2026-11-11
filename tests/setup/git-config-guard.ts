import {
  assertConfigUnchanged,
  type ConfigSnapshot,
  snapshotLocalConfig,
} from '../_shared/git-config-guard.js';

/**
 * Vitest globalSetup: fail the run when it changed the shared .git/config.
 * One git call on each side; see tests/_shared/git-config-guard.ts.
 *
 * A throw from a global teardown only prints "error during close" and leaves
 * the exit code at 0 (verified on vitest 5.1.0), so the teardown reports the
 * problem itself and sets the exit code: a green-looking run that corrupted
 * the config is exactly what this guard exists to prevent.
 *
 * `createGuard`'s `snapshot` is injectable so the failure path is testable without touching
 * the live shared config.
 */
export function createGuard(snapshot: () => ConfigSnapshot) {
  const before = snapshot();
  return () => {
    try {
      assertConfigUnchanged(before, snapshot());
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  };
}

// vitest passes its own project argument to a globalSetup, so the default
// export takes none and the injectable form is the named one above.
export default function setup() {
  return createGuard(() => snapshotLocalConfig(process.cwd()));
}
