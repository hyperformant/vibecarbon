/**
 * CI safety-net sweep, state half: removes the Pulumi stacks of past CI runs
 * whose recorded resources are all gone (sweepRunStacks), on every provider
 * whose storage credentials are present.
 *
 * Only projects of this namespace's scratch prefix that started more than
 * STALE_RUN_MAX_AGE_MS ago are judged (ownsStaleScratchProject), so a run in
 * flight is never touched. Advisory: always exits 0, and a provider whose
 * bucket cannot be reached prints a warning and moves on.
 *
 * Usage: tsx tests/e2e/sweep-stale-stacks-ci.ts [--dry-run]
 *   --dry-run lists and decides, and logs `would delete <key>` per key.
 */

import { join } from 'node:path';
import { applyNetworkDefaults } from '../../src/lib/net-defaults.js';
import { testConfig } from '../config.js';
import { readE2EEnv } from './utils/e2e-env-file.js';
import { probeFor } from './utils/stack-probes.ts';
import { e2eStateStore, ownsStaleScratchProject } from './utils/state-store.ts';
import { sweepRunStacks } from './utils/sweep-run-stacks.ts';

applyNetworkDefaults();

const TAG = '[sweep-stale-stacks-ci]';
const dryRun = process.argv.includes('--dry-run');

// The operator env file fills in only what the real env leaves blank (the
// same lookup sweep-project.ts uses); CI passes everything through env.
const env = readE2EEnv(join(import.meta.dirname, '..', '.env.e2e'));

for (const [provider, entry] of Object.entries(testConfig.e2e.providers)) {
  try {
    const owns = ownsStaleScratchProject(Date.now(), env as NodeJS.ProcessEnv);
    const token = env[entry.computeTokenEnv];
    const store = token ? e2eStateStore(provider, env, { dryRun }) : null;
    if (!store || !token) {
      console.log(`${TAG} ${provider}: skipped (no credentials)`);
      continue;
    }
    const at = await store.where();
    if (!at) {
      // list() logs why (not found, or the answer that stopped the look).
      await store.list('.pulumi/stacks/');
      console.warn(`${TAG} ${provider}: state bucket not located, nothing swept`);
      continue;
    }
    const { deleted, kept } = await sweepRunStacks(
      `${TAG} ${provider}`,
      owns,
      store,
      probeFor(provider, { token, env }),
    );
    console.log(
      `${TAG} ${provider}: ${at.bucket} (${at.region}): ${deleted.length + kept.length} stale-project stack(s) judged, ${deleted.length} deleted, ${kept.length} kept${dryRun ? ' (dry run)' : ''}`,
    );
  } catch (e) {
    console.warn(`${TAG} ${provider}: skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(0);
