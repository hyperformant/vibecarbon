/**
 * On a GitOps environment the app and infra Secrets are applied by
 * `vibecarbon deploy <env>`, as on any k8s environment: Flux drops both from
 * its build and no workflow writes them any more. This pins what makes that
 * true: a secret changed in .env.local changes the k3s apply gate's digest,
 * so the next deploy re-applies the Secrets, and no deploy step is skipped
 * for an environment `configure cicd` set up.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestEnvLocalSecrets } from '../../../src/lib/deploy/k8s/k3s.js';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { REPO_ROOT } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const writeEnvLocal = (dir: string, values: Record<string, string>) =>
  writeFileSync(
    join(dir, '.env.local'),
    `${Object.entries(values)
      .map(([key, value]) => formatDotenvLine(key, value))
      .join('\n')}\n`,
  );

describe('a GitOps environment gets its Secrets from deploy', () => {
  it('a changed app or infra secret in .env.local changes the apply digest, so deploy re-applies it', () => {
    const dir = createTempDir('vc-gitops-secrets-');
    const values = { BETTER_AUTH_SECRET: 'auth-one', DB_PASSWORD: 'db-one' };
    writeEnvLocal(dir, values);
    const first = digestEnvLocalSecrets(dir);
    // The app Secret's session key.
    writeEnvLocal(dir, { ...values, BETTER_AUTH_SECRET: 'auth-two' });
    const second = digestEnvLocalSecrets(dir);
    expect(second).not.toBe(first);
    // The infra Secret's database password.
    writeEnvLocal(dir, { ...values, BETTER_AUTH_SECRET: 'auth-two', DB_PASSWORD: 'db-two' });
    const third = digestEnvLocalSecrets(dir);
    expect(third).not.toBe(second);
    expect(third).not.toBe(first);
  });

  it('no deploy step is gated on cicdEnabled', () => {
    for (const rel of ['src/lib/deploy/k8s/k3s.js', 'src/lib/deploy/orchestrator.js']) {
      expect(readFileSync(join(REPO_ROOT, rel), 'utf-8'), rel).not.toContain('cicdEnabled');
    }
  });
});
