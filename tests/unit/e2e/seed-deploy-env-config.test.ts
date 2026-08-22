import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDeployEnvConfig } from '../../../tests/e2e/utils/cli-runner.js';

/**
 * Regression coverage for a d1 (DigitalOcean) restore-after-destroy failure:
 * the restore step's `runDeploy()` call omitted `provider`, so the re-seed
 * wrote region/serverType/domain/dnsProvider but left `provider` unset —
 * the redeployed CLI then defaulted to Hetzner (providerFor's sanctioned
 * fallback for a missing `provider` key) and its region guard rejected the
 * DO-only region ('nyc3' isn't a Hetzner region), failing the redeploy
 * instantly. The fix threads `provider: config.provider` through every
 * `runDeploy()` call site in _run-lifecycle.ts (see the sibling wiring test);
 * this file pins the underlying seed helper's write behavior directly.
 */
describe('seedDeployEnvConfig', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'seed-env-config-test-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readEnvConfig(envName: string): Record<string, unknown> {
    const raw = readFileSync(join(projectDir, '.vibecarbon.json'), 'utf-8');
    const config = JSON.parse(raw) as { environments: Record<string, Record<string, unknown>> };
    return config.environments[envName];
  }

  it('writes provider for a DigitalOcean scenario', () => {
    seedDeployEnvConfig(projectDir, 'd1', {
      region: 'nyc3',
      serverType: 's-2vcpu-4gb',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      provider: 'digitalocean',
    });

    const envCfg = readEnvConfig('d1');
    expect(envCfg.provider).toBe('digitalocean');
    expect(envCfg.region).toBe('nyc3');
    expect(envCfg.serverType).toBe('s-2vcpu-4gb');
  });

  it('leaves provider absent (hetzner-consistent) for a release scenario that never passes it', () => {
    seedDeployEnvConfig(projectDir, 'prod', {
      region: 'fsn1',
      serverType: 'cx23',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      // provider intentionally omitted — the 4 release scenarios never set it.
    });

    const envCfg = readEnvConfig('prod');
    expect(envCfg).not.toHaveProperty('provider');
    expect(envCfg.region).toBe('fsn1');
  });

  it('is idempotent across a re-seed (restore-after-destroy re-invocation): provider set once, stays set', () => {
    seedDeployEnvConfig(projectDir, 'd1', {
      region: 'nyc3',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      provider: 'digitalocean',
    });
    // Second seed call (e.g. the restore step re-invoking with the same
    // scenario config) must not drop the previously-written provider.
    seedDeployEnvConfig(projectDir, 'd1', {
      region: 'nyc3',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      provider: 'digitalocean',
    });

    expect(readEnvConfig('d1').provider).toBe('digitalocean');
  });

  it('merges into an existing config file rather than overwriting other environments', () => {
    seedDeployEnvConfig(projectDir, 'd1', {
      region: 'nyc3',
      domain: 'd1.example.com',
      dnsProvider: 'cloudflare',
      provider: 'digitalocean',
    });
    seedDeployEnvConfig(projectDir, 'e1', {
      region: 'fsn1',
      domain: 'e1.example.com',
      dnsProvider: 'cloudflare',
    });

    expect(existsSync(join(projectDir, '.vibecarbon.json'))).toBe(true);
    expect(readEnvConfig('d1').provider).toBe('digitalocean');
    expect(readEnvConfig('e1')).not.toHaveProperty('provider');
  });
});
