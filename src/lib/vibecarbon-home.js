/**
 * The one directory the CLI keeps its per-user state in: deploy logs, the
 * project registry, local Pulumi state, the SSH mux sockets, locks, the
 * fingerprint key, telemetry and update-check state. ~/.vibecarbon unless
 * VIBECARBON_HOME names another directory.
 *
 * The test tiers set VIBECARBON_HOME per test file (tests/setup/global-setup.ts),
 * and every CLI child a test spawns inherits it, so no test writes the
 * developer's own ~/.vibecarbon. Before this, one laptop had 751 deploy logs
 * and 614 registry entries from test runs. A few modules build their path
 * when they load (the SSH mux dir, local Pulumi state, the uplink lock), so
 * set it before the process starts, as the test setup does.
 *
 * Every path into this directory goes through here
 * (tests/unit/lib/vibecarbon-home-census.test.ts).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function vibecarbonHome() {
  return process.env.VIBECARBON_HOME || join(homedir(), '.vibecarbon');
}
