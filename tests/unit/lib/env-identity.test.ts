import { describe, expect, it } from 'vitest';
import { ENV_IDENTITY_FIELDS, envIdentityOf } from '../../../src/lib/env-identity.js';

/**
 * The fields of an environment that describe WHAT it is (placement, domain,
 * DNS, backup bucket, server sizing) as opposed to what currently EXISTS
 * (servers, live storage bucket, deploy state). destroy records the former
 * under `destroyedEnvironments.<env>` so a redeploy of the same name starts
 * from them instead of a hand-typed JSON block (region-move runbook,
 * 2026-09-15); deploy reads it back and clears it once the env is live.
 */
describe('envIdentityOf', () => {
  const live = {
    provider: 'hetzner',
    envName: 'prod',
    deployMode: 'compose',
    domain: 'app.example.com',
    dnsProvider: 'cloudflare',
    dns: { provider: 'cloudflare', zoneId: 'z1' },
    backupS3: { bucket: 'proj-abc-backups', region: 'fsn1', endpoint: 'https://fsn1.x' },
    backup: { schedule: '0 */6 * * *', retentionDays: 30 },
    region: 'ash',
    secondaryRegion: 'hil',
    serverType: 'cpx21',
    masterServerType: 'cpx22',
    supabaseServerType: 'cpx32',
    workerServerType: 'cpx22',
    // runtime — must NOT carry over
    status: 'deployed',
    servers: [{ name: 'master', id: '1', ip: '5.161.241.125' }],
    s3: { bucket: 'proj-abc-storage-7b6f58', stateBucket: 'x-pulumi-state-c86bb1' },
    deployedAt: '2026-08-30T15:30:41Z',
    deployedCommit: 'edd67e5',
    lastAttempt: '2026-08-30T15:29:56Z',
    deployedDirty: false,
    ha: { enabled: true, primary: { masterIp: '1.1.1.1' } },
    networkId: '123',
  };

  it('keeps placement, domain, DNS, backup bucket and server sizing', () => {
    const id = envIdentityOf(live);
    expect(id).toEqual({
      provider: 'hetzner',
      envName: 'prod',
      deployMode: 'compose',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      dns: { provider: 'cloudflare', zoneId: 'z1' },
      backupS3: { bucket: 'proj-abc-backups', region: 'fsn1', endpoint: 'https://fsn1.x' },
      backup: { schedule: '0 */6 * * *', retentionDays: 30 },
      region: 'ash',
      secondaryRegion: 'hil',
      serverType: 'cpx21',
      masterServerType: 'cpx22',
      supabaseServerType: 'cpx32',
      workerServerType: 'cpx22',
    });
  });

  it('drops every runtime field (servers, live storage bucket, deploy state, HA topology)', () => {
    const id = envIdentityOf(live) as Record<string, unknown>;
    for (const k of [
      'status',
      'servers',
      's3',
      'deployedAt',
      'deployedCommit',
      'lastAttempt',
      'deployedDirty',
      'ha',
      'networkId',
    ]) {
      expect(id, k).not.toHaveProperty(k);
    }
  });

  it('omits identity fields the env never had rather than writing undefined', () => {
    expect(envIdentityOf({ provider: 'hetzner', domain: 'a.b' })).toEqual({
      provider: 'hetzner',
      domain: 'a.b',
    });
  });

  it('the allowlist is explicit and never includes the live storage bucket', () => {
    expect(ENV_IDENTITY_FIELDS).toContain('backupS3');
    expect(ENV_IDENTITY_FIELDS).not.toContain('s3');
    expect(ENV_IDENTITY_FIELDS).not.toContain('servers');
  });
});

describe('resolveEnvSeed (deploy-side read)', () => {
  it('prefers the live environment when it exists', async () => {
    const { resolveEnvSeed } = await import('../../../src/lib/env-identity.js');
    const cfg = {
      environments: { prod: { status: 'deployed', region: 'fsn1' } },
      destroyedEnvironments: { prod: { region: 'ash', destroyedAt: '2026-09-15T17:03:00Z' } },
    };
    expect(resolveEnvSeed(cfg, 'prod')).toEqual({
      envConfig: { status: 'deployed', region: 'fsn1' },
      fromDestroyed: null,
    });
  });

  it('falls back to the recorded identity of a destroyed environment of the same name', async () => {
    const { resolveEnvSeed } = await import('../../../src/lib/env-identity.js');
    const cfg = {
      environments: {},
      destroyedEnvironments: {
        prod: {
          provider: 'hetzner',
          domain: 'a.b',
          region: 'ash',
          destroyedAt: '2026-09-15T17:03:00Z',
        },
      },
    };
    const r = resolveEnvSeed(cfg, 'prod');
    expect(r.envConfig).toEqual({ provider: 'hetzner', domain: 'a.b', region: 'ash' });
    expect(r.fromDestroyed).toEqual({ destroyedAt: '2026-09-15T17:03:00Z' });
    // destroyedAt is bookkeeping, not env config — it must not leak into the
    // block deploy persists.
    expect(r.envConfig).not.toHaveProperty('destroyedAt');
  });

  it('returns an empty block for a name that never existed', async () => {
    const { resolveEnvSeed } = await import('../../../src/lib/env-identity.js');
    expect(resolveEnvSeed({ environments: {} }, 'staging')).toEqual({
      envConfig: {},
      fromDestroyed: null,
    });
  });
});

describe('clearDestroyedRecord', () => {
  it('removes the record for that env and drops the map when empty', async () => {
    const { clearDestroyedRecord } = await import('../../../src/lib/env-identity.js');
    const cfg = {
      environments: { prod: { status: 'deployed' } },
      destroyedEnvironments: { prod: { region: 'ash', destroyedAt: 'x' } },
    };
    const out = clearDestroyedRecord(cfg, 'prod');
    expect(out).not.toHaveProperty('destroyedEnvironments');
    expect(out.environments).toEqual({ prod: { status: 'deployed' } });
    expect(cfg.destroyedEnvironments).toEqual({ prod: { region: 'ash', destroyedAt: 'x' } }); // pure
  });

  it('leaves other envs’ records alone and is a no-op without a record', async () => {
    const { clearDestroyedRecord } = await import('../../../src/lib/env-identity.js');
    const cfg = { destroyedEnvironments: { staging: { region: 'nbg1', destroyedAt: 'y' } } };
    expect(clearDestroyedRecord(cfg, 'prod')).toEqual(cfg);
    expect(clearDestroyedRecord({ environments: {} }, 'prod')).toEqual({ environments: {} });
  });
});

describe('deploy wiring (static)', () => {
  it('prompts.js seeds envConfig via resolveEnvSeed and the orchestrator clears the record before the final save', async () => {
    const { readFileSync } = await import('node:fs');
    const prompts = readFileSync('src/lib/deploy/prompts.js', 'utf8');
    expect(prompts).toMatch(/resolveEnvSeed\(projectConfig,\s*environment\)/);
    const orch = readFileSync('src/lib/deploy/orchestrator.js', 'utf8');
    // The final persist must go THROUGH the clear, not merely near it.
    expect(orch).toMatch(/saveProjectConfig\(clearDestroyedRecord\(finalConfig,\s*environment\)\)/);
  });
});
