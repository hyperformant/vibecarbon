/**
 * The four per-provider CI safety-net sweeps (tests/e2e/sweep-<provider>-ci.ts)
 * as e2e-us-perf.yml runs them.
 *
 * Each is a top-level script, so the only way to see one whole is to run it.
 * Without its compute token a script must say which variable is missing and
 * exit 0: the workflow step is inert until that provider's secrets exist, and
 * a leg must not go red for a provider nobody configured. That is the one
 * path that runs with no cloud behind it, and it is run here for real.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const ENTRY_POINTS = [
  {
    file: 'tests/e2e/sweep-digitalocean-ci.ts',
    tokenEnv: 'DIGITALOCEAN_API_TOKEN',
    line: '[sweep-do-ci] DIGITALOCEAN_API_TOKEN not set — skipping (no DO secrets configured).',
  },
  {
    file: 'tests/e2e/sweep-linode-ci.ts',
    tokenEnv: 'LINODE_API_TOKEN',
    line: '[sweep-linode-ci] LINODE_API_TOKEN not set — skipping (no Linode secrets configured).',
  },
  {
    file: 'tests/e2e/sweep-vultr-ci.ts',
    tokenEnv: 'VULTR_API_TOKEN',
    line: '[sweep-vultr-ci] VULTR_API_TOKEN not set — skipping (no Vultr secrets configured).',
  },
  {
    file: 'tests/e2e/sweep-scaleway-ci.ts',
    tokenEnv: 'SCALEWAY_SECRET_KEY',
    line: '[sweep-scaleway-ci] SCALEWAY_SECRET_KEY not set — skipping (no Scaleway secrets configured).',
  },
];

describe('CI safety-net sweep entry points', () => {
  it.each(ENTRY_POINTS)(
    '$file without $tokenEnv says so and exits 0',
    ({ file, line }) => {
      // Every provider's token is removed, not just this script's: a script
      // that read the wrong variable would otherwise start a real sweep.
      const env = { ...process.env, E2E_NAMESPACE: 'ci' };
      for (const entry of ENTRY_POINTS) delete env[entry.tokenEnv];
      const run = spawnSync(process.execPath, ['--import', 'tsx', file], {
        cwd: ROOT,
        env,
        encoding: 'utf-8',
        timeout: 60_000,
      });
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe(`${line}\n`);
      expect(run.status).toBe(0);
    },
    90_000,
  );
});
