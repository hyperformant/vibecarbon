/**
 * compose-HA persists the env mid-flight (status 'deploying') so a destroy can
 * clean up a deploy that dies later. That save rebuilt `s3` from scratch and
 * dropped the per-environment storage fields: `keyPrefix` (without it destroy
 * deletes none of this env's objects), the `corsOrigins` the skeleton save
 * claimed (without them destroy falls back to the computed set), and
 * `bucketCreatedAt` (status' settling row). This drives haPersistPendingConfig
 * directly and checks all three survive.
 */
import { describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  saved: null as Record<string, unknown> | null,
}));
vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadProjectConfig: () => disk.config,
    saveProjectConfig: (cfg: Record<string, unknown>) => {
      disk.saved = cfg;
    },
    registerProject: () => {},
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

const s3Of = (cfg: Record<string, unknown> | null) =>
  (cfg as { environments: Record<string, { s3: Record<string, unknown> }> }).environments.prod.s3;

function ctx(envConfig: Record<string, unknown>) {
  return {
    projectConfig: { projectName: 'myapp' },
    environment: 'prod',
    envConfig,
    region: 'fsn1',
    standbyRegion: 'nbg1',
    serverType: 'cx33',
    standbyServerType: 'cx33',
    primary: { serverId: '1', ip: '10.0.0.1' },
    standby: { serverId: '2', ip: '10.0.0.2' },
    domain: 'prod.dev',
    dnsProvider: 'hetzner',
    services: {},
    s3Config: {
      bucket: 'myapp-cd9ecc-storage',
      keyPrefix: 'prod/',
      region: 'fsn1',
      endpoint: 'https://fsn1.your-objectstorage.com',
      stateBucket: 'myapp-cd9ecc-storage-pulumi-state-aaaaaa',
    },
  } as Record<string, unknown>;
}

describe('haPersistPendingConfig keeps the per-environment storage fields', () => {
  it('persists keyPrefix, the skeleton-claimed corsOrigins and bucketCreatedAt', async () => {
    disk.config = {
      projectName: 'myapp',
      environments: {
        prod: {
          status: 'deploying',
          s3: {
            bucket: 'myapp-cd9ecc-storage',
            keyPrefix: 'prod/',
            corsOrigins: ['https://prod.dev'],
          },
        },
      },
    };
    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(
      ctx({ provider: 'hetzner', s3: { bucketCreatedAt: '2026-10-20T10:00:00.000Z' } }),
    );
    expect(s3Of(disk.saved)).toMatchObject({
      bucket: 'myapp-cd9ecc-storage',
      keyPrefix: 'prod/',
      corsOrigins: ['https://prod.dev'],
      bucketCreatedAt: '2026-10-20T10:00:00.000Z',
    });
  });

  it('keeps an explicit null bucketCreatedAt and adds no key when none was recorded', async () => {
    disk.config = { projectName: 'myapp', environments: {} };
    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(
      ctx({ provider: 'hetzner', s3: { bucketCreatedAt: null } }),
    );
    expect(s3Of(disk.saved).bucketCreatedAt).toBeNull();

    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(ctx({ provider: 'hetzner' }));
    expect(s3Of(disk.saved)).not.toHaveProperty('bucketCreatedAt');
    expect(s3Of(disk.saved)).not.toHaveProperty('corsOrigins');
    expect(s3Of(disk.saved).keyPrefix).toBe('prod/');
  });
});
