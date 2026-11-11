import { assertConfigUnchanged, snapshotLocalConfig } from '../_shared/git-config-guard.js';

/**
 * Vitest globalSetup: fail the run when it changed the shared .git/config.
 * One git call on each side; see tests/_shared/git-config-guard.ts.
 *
 * A throw from a global teardown only prints "error during close" and leaves
 * the exit code at 0 (verified on vitest 5.1.0), so the teardown reports the
 * problem itself and sets the exit code: a green-looking run that corrupted
 * the config is exactly what this guard exists to prevent.
 */
export default function setup() {
  const before = snapshotLocalConfig(process.cwd());
  return () => {
    try {
      assertConfigUnchanged(before, snapshotLocalConfig(process.cwd()));
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  };
}
