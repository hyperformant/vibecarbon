/**
 * `scripts/iter-step.js` must run a step against a kept rig under the SAME
 * environment `tests/e2e/runner.ts` gives that step inside a full run.
 *
 * It didn't. iter-step hand-copied three of the runner's child-env vars and
 * inherited none of its process-level setup, so an iterated step ran with
 * production Let's Encrypt (5 certs/week/identifier — the exact rate limit
 * the harness moved to staging to avoid), no operator token file, no
 * ssh-askpass guard, and no staging-CA trust. During the M3 battery an
 * iter-step deploy failed its health probe for precisely that reason and had
 * to be re-run behind a hand-written env prefix.
 *
 * Both call sites now go through tests/e2e/utils/e2e-env.js. These tests pin
 * the contract and guard against the copy creeping back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { e2eCliEnv, REPO_ROOT } from '../../../tests/e2e/utils/e2e-env.js';

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf-8');

describe('e2eCliEnv', () => {
  it('supplies the defaults every e2e CLI child needs', () => {
    const env = e2eCliEnv({}, {});
    // Perf markers parsed by metrics/reporter.ts.
    expect(env.VIBECARBON_PERF).toBe('1');
    // Disposable rigs: -y deploys need an operator CIDR list.
    expect(env.ALLOWED_SSH_IPS).toBe('0.0.0.0/0,::/0');
    // Telemetry goes to a closed port, whatever the shell exported.
    expect(env.VIBECARBON_API_BASE).toBe('http://127.0.0.1:9');
    expect(
      e2eCliEnv({}, { VIBECARBON_API_BASE: 'https://example.com' } as NodeJS.ProcessEnv)
        .VIBECARBON_API_BASE,
    ).toBe('http://127.0.0.1:9');
  });

  it('lets the real environment override a default, and a per-call value override both', () => {
    const base = { ALLOWED_SSH_IPS: '10.0.0.0/8' } as NodeJS.ProcessEnv;
    expect(e2eCliEnv({}, base).ALLOWED_SSH_IPS).toBe('10.0.0.0/8');
    expect(e2eCliEnv({ ALLOWED_SSH_IPS: '1.2.3.4/32' }, base).ALLOWED_SSH_IPS).toBe('1.2.3.4/32');
  });

  it('mirrors the runner by aliasing HETZNER_API_TOKEN to the provider CLI var', () => {
    // _run-lifecycle.ts passes HCLOUD_TOKEN explicitly to every step it runs.
    const env = e2eCliEnv({}, { HETZNER_API_TOKEN: 'tok' } as NodeJS.ProcessEnv, 'hetzner');
    expect(env.HCLOUD_TOKEN).toBe('tok');
  });

  it('never overwrites an explicit HCLOUD_TOKEN, and never invents one', () => {
    const explicit = e2eCliEnv(
      {},
      {
        HETZNER_API_TOKEN: 'tok',
        HCLOUD_TOKEN: 'other',
      } as NodeJS.ProcessEnv,
      'hetzner',
    );
    expect(explicit.HCLOUD_TOKEN).toBe('other');
    expect(e2eCliEnv({}, {}, 'hetzner').HCLOUD_TOKEN).toBeUndefined();
  });

  it('a DigitalOcean child gets no HCLOUD_TOKEN, and an inherited one is stripped', () => {
    const base = {
      HETZNER_API_TOKEN: 'hz',
      HCLOUD_TOKEN: 'hz',
      DIGITALOCEAN_API_TOKEN: 'do',
    } as NodeJS.ProcessEnv;
    for (const provider of ['digitalocean', 'linode', 'vultr', 'scaleway', undefined]) {
      const env = e2eCliEnv({}, base, provider);
      expect(env.HCLOUD_TOKEN).toBeUndefined();
      expect(Object.values(env)).not.toContain(undefined);
    }
    expect(e2eCliEnv({}, base, 'digitalocean').DIGITALOCEAN_API_TOKEN).toBe('do');
  });

  it('drops undefined values (spawn rejects them on some platforms)', () => {
    const env = e2eCliEnv({ SOMETHING: undefined }, { OTHER: undefined } as NodeJS.ProcessEnv);
    expect('SOMETHING' in env).toBe(false);
    expect('OTHER' in env).toBe(false);
  });
});

describe('runner ↔ iter-step parity (drift guards)', () => {
  const iterStep = read('scripts', 'iter-step.js');
  const cliRunner = read('tests', 'e2e', 'utils', 'cli-runner.ts');
  const runner = read('tests', 'e2e', 'runner.ts');

  it('iter-step establishes the runner’s process env', () => {
    expect(iterStep).toMatch(/setupE2EEnv\(\)/);
  });

  it('iter-step and cli-runner build the child env from the same helper', () => {
    expect(iterStep).toMatch(/e2eCliEnv\(/);
    expect(cliRunner).toMatch(/e2eCliEnv\(/);
  });

  it('the runner establishes its process env through the shared module too', () => {
    expect(runner).toMatch(/setupE2EEnv\(\)/);
    expect(runner).toMatch(/from '\.\/utils\/e2e-env\.js'/);
  });

  it('iter-step no longer hand-copies the child env vars', () => {
    // The literals below are the copy that drifted. They belong in
    // tests/e2e/utils/e2e-env.js and nowhere else.
    expect(iterStep).not.toMatch(/ALLOWED_SSH_IPS:\s*'0\.0\.0\.0\/0/);
    expect(iterStep).not.toMatch(/VIBECARBON_PERF:\s*'1'/);
  });

  it('the ACME staging pin lives only in the shared module', () => {
    // A second copy of this URL is how iter-step ended up on production LE.
    expect(runner).not.toContain('acme-staging-v02.api.letsencrypt.org/directory');
    expect(iterStep).not.toContain('acme-staging-v02.api.letsencrypt.org/directory');
    expect(read('tests', 'e2e', 'utils', 'e2e-env.js')).toContain(
      'https://acme-staging-v02.api.letsencrypt.org/directory',
    );
  });
});
