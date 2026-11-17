/**
 * The e2e harness's own CLI home. Importing this module sets VIBECARBON_HOME
 * to ~/.vibecarbon-e2e (0700) unless the environment already names one.
 *
 * Real-infra e2e runs `create`, `deploy` and `destroy` for throwaway projects.
 * Under the developer's real ~/.vibecarbon that filled the project registry
 * and the log folder with test entries.
 *
 * ONE fixed directory for every run, not one per run or per scenario:
 *   - runs in parallel must share locks/uplink-push.lock, which keeps their
 *     image pushes from fighting over the same uplink;
 *   - a kept rig (`--keep`, then scripts/iter-step.js) must find on the next
 *     invocation what the first one wrote: the fingerprint key, the volume
 *     ledger, the logs.
 *
 * A VIBECARBON_HOME already in the environment wins, so a workflow or a
 * developer can point the harness somewhere else.
 *
 * IMPORT THIS FIRST in every e2e entry point (tests/e2e/runner.ts,
 * scripts/iter-step.js, scripts/sweep-hetzner.js). A few src modules build
 * their path when they load (the SSH mux dir, local Pulumi state, the uplink
 * lock), and a module's imports all load before its first statement runs, so
 * a call from the entry point's body would be too late. Every `vibecarbon`
 * child inherits the variable through process.env.
 * Guarded by tests/unit/e2e/e2e-home.test.ts.
 *
 * Node builtins only, on purpose: anything else imported here would load
 * before the variable is set. Plain JS because scripts/iter-step.js runs
 * under bare node.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const E2E_HOME_DIRNAME = '.vibecarbon-e2e';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home] The user's home directory.
 * @returns {string} The preset VIBECARBON_HOME, else <home>/.vibecarbon-e2e.
 */
export function resolveE2EHome(env = process.env, home = homedir()) {
  return env.VIBECARBON_HOME || join(home, E2E_HOME_DIRNAME);
}

process.env.VIBECARBON_HOME = resolveE2EHome();
mkdirSync(process.env.VIBECARBON_HOME, { recursive: true, mode: 0o700 });
