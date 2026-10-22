/**
 * A redeploy keeps the Pulumi state bucket the environment has been using.
 *
 * gatherDeploymentConfig carries the persisted `s3.stateBucket` into
 * s3Config, so resolveStateBucketName's first rule (the env's PERSISTED name)
 * is the one that answers. Without it every redeploy derived the name fresh,
 * and for a project created since 2026-08-17 (storageBucketGeneration set)
 * the old CLI derived it from `<project>-<salt>-storage-<gen>` while this one
 * derives from `<project>-<salt>-storage`: a different, EMPTY bucket, so
 * Pulumi planned from empty state and the save overwrote the real name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  password: vi.fn(),
  note: vi.fn(),
  intro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    step: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);

// Main's derivation for a generation-bearing project: from the persisted app
// bucket `<project>-<salt>-storage-<sgen>`.
const MAIN_APP_BUCKET = 'genapp-abc123-storage-0f1e2d';
const PERSISTED_STATE = 'genapp-abc123-storage-0f1e2d-pulumi-state-9a8b7c';

const project = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../../src/lib/config.js', () => ({
  loadProjectConfig: () => project.current,
}));
vi.mock('../../../src/lib/licensing/index.js', () => ({
  requireDeployEntitlement: vi.fn(async () => undefined),
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', () => ({
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));
vi.mock('../../../src/lib/deploy/preflight.js', () => ({ assertOperatorConfig: vi.fn() }));
vi.mock('../../../src/lib/ci-setup.js', () => ({ ciAvailable: () => false }));

import { gatherDeploymentConfig } from '../../../src/lib/deploy/prompts.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import {
  projectStateBucketBase,
  resolveStateBucketName,
  S3CompatibleProvider,
} from '../../../src/lib/providers/s3-base.js';

function liveMainEnvProject() {
  return {
    projectName: 'genapp',
    bucketSalt: 'abc123',
    storageBucketGeneration: '0f1e2d',
    stateBucketGeneration: '9a8b7c',
    environments: {
      prod: {
        envName: 'prod',
        provider: 'hetzner',
        deployMode: 'compose',
        region: 'nbg1',
        status: 'deployed',
        dnsProvider: 'manual',
        s3: {
          bucket: MAIN_APP_BUCKET,
          // The mismatch remedy: pin the bucket main created, then redeploy.
          bucketPin: MAIN_APP_BUCKET,
          region: 'nbg1',
          endpoint: 'https://nbg1.your-objectstorage.com',
          stateBucket: PERSISTED_STATE,
        },
      },
    },
  };
}

describe('redeploy keeps the persisted Pulumi state bucket', () => {
  beforeEach(() => {
    project.current = liveMainEnvProject();
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(HetznerProvider, 'promptApiToken').mockResolvedValue('a'.repeat(64) as never);
    vi.spyOn(HetznerProvider, 'fetchServerTypes').mockResolvedValue(undefined as never);
    vi.spyOn(HetznerProvider, 'getRegionDefaults').mockReturnValue({
      composeType: 'cpx31',
      dbType: 'cpx31',
      masterType: 'cpx31',
      workerType: 'cpx31',
    } as never);
    vi.spyOn(HetznerProvider, 'assertAmd64ServerType').mockImplementation(() => {});
    vi.spyOn(HetznerProvider, 'promptObjectStorageCredentials').mockResolvedValue({
      accessKey: 'ABCDEFGHIJ0123456789',
      secretKey: 'x'.repeat(40),
      source: 'prompt',
    } as never);
    vi.spyOn(S3CompatibleProvider.prototype, 'validateCredentials').mockResolvedValue({
      valid: true,
    });
    clackMock.select.mockImplementation(async ({ message }: { message: string }) => {
      throw new Error(`unexpected select: ${message}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clackMock.select.mockReset();
  });

  it('carries s3.stateBucket into s3Config, so the persisted name wins over derivation', async () => {
    const gathered = await gatherDeploymentConfig({
      env: 'prod',
      provider: 'hetzner',
      compose: true,
      region: 'nbg1',
      yes: true,
    });
    expect(gathered.s3Config.stateBucket).toBe(PERSISTED_STATE);

    const pc = project.current as { stateBucketGeneration: string };
    const resolved = resolveStateBucketName({
      envStateBucket: gathered.s3Config.stateBucket,
      projectBase: projectStateBucketBase(project.current as never),
      generation: pc.stateBucketGeneration,
    });
    expect(resolved).toBe(PERSISTED_STATE);
    // The fresh derivation is a different bucket; this is what the carry avoids.
    expect(
      resolveStateBucketName({
        projectBase: projectStateBucketBase(project.current as never),
        generation: pc.stateBucketGeneration,
      }),
    ).not.toBe(PERSISTED_STATE);
  });

  it('leaves stateBucket unset for an environment that never persisted one', async () => {
    const env = (project.current as { environments: { prod: { s3: Record<string, unknown> } } })
      .environments.prod;
    delete env.s3.stateBucket;
    const gathered = await gatherDeploymentConfig({
      env: 'prod',
      provider: 'hetzner',
      compose: true,
      region: 'nbg1',
      yes: true,
    });
    expect(Object.hasOwn(gathered.s3Config, 'stateBucket')).toBe(false);
  });
});
