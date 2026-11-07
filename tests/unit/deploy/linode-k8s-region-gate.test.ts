/**
 * A Linode k8s or k8s-ha deploy to a region without a VPC (us-east,
 * us-southeast) is refused inside gatherDeploymentConfig, right after the tier
 * is known: no token prompt, catalog fetch, S3 key prompt or select runs, so
 * no provider API or Pulumi work can follow. The interactive region and
 * standby lists for those tiers omit the two regions. Harness as in
 * gather-scaffold-lockstep.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';
import { copyTemplate } from '../helpers/copy-template.js';

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
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProjectConfig: () => ({
    projectName: 'lockapp',
    bucketSalt: 'abc123',
    environments: { prod: { provider: 'linode' } },
  }),
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', () => ({
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));
vi.mock('../../../src/lib/deploy/preflight.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertOperatorConfig: vi.fn(),
}));
vi.mock('../../../src/lib/ci-setup.js', () => ({ ciAvailable: () => false }));

import { gatherDeploymentConfig } from '../../../src/lib/deploy/prompts.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-gather-linode-region-'));
  dirs.push(dir);
  copyTemplate(dir);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
}

let restoreCatalog: () => void;
const later = {
  apiToken: vi.fn(),
  fetchTypes: vi.fn(),
  s3Keys: vi.fn(),
};
beforeEach(() => {
  vi.spyOn(console, 'clear').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(LinodeProvider, 'promptApiToken').mockImplementation(async () => {
    later.apiToken();
    return 'a'.repeat(64);
  });
  vi.spyOn(LinodeProvider, 'fetchServerTypes').mockImplementation(async () => {
    later.fetchTypes();
    return undefined as never;
  });
  vi.spyOn(LinodeProvider, 'promptObjectStorageCredentials').mockImplementation(async () => {
    later.s3Keys();
    return { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40), source: 'prompt' };
  });
  restoreCatalog = seedCatalog(LinodeProvider, '2026-10-22/linode');
});
afterEach(() => {
  restoreCatalog();
  vi.restoreAllMocks();
  for (const fn of Object.values(later)) fn.mockClear();
  for (const fn of [clackMock.select, clackMock.text, clackMock.password]) fn.mockClear();
  clackMock.log.error.mockClear();
});

describe('deploy: Linode k8s tiers refuse regions without a VPC', () => {
  it.each([
    ['k8s', { k8s: true }, 'us-east'],
    ['k8s', { k8s: true }, 'us-southeast'],
    ['k8s-ha', { k8s: true, ha: true }, 'us-east'],
  ])('%s -region %s: refused before any prompt or provider call', async (_tier, mode, region) => {
    project();
    const err = await gatherDeploymentConfig({
      env: 'prod',
      yes: true,
      region,
      ...mode,
    }).catch((e) => e);
    expect(String(err)).toContain(
      `Kubernetes on Linode does not run in ${region === 'us-east' ? 'Newark' : 'Atlanta'} (${region}): Linode has no VPC there for the cluster's private network. Use us-iad, us-ord or another region.`,
    );
    for (const [name, fn] of Object.entries(later)) {
      expect(fn, `${name} ran before the refusal`).not.toHaveBeenCalled();
    }
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('k8s-ha -standby-region us-southeast is refused the same way', async () => {
    project();
    const err = await gatherDeploymentConfig({
      env: 'prod',
      yes: true,
      region: 'us-iad',
      secondaryRegion: 'us-southeast',
      k8s: true,
      ha: true,
    }).catch((e) => e);
    expect(String(err)).toContain('does not run in Atlanta (us-southeast)');
    expect(later.apiToken).not.toHaveBeenCalled();
  });

  it.each([
    ['k8s', { k8s: true }],
    ['k8s-ha', { k8s: true, ha: true }],
  ])('%s: the interactive region and standby lists omit the two regions', async (_tier, mode) => {
    project();
    const lists: Record<string, string[]> = {};
    clackMock.select.mockImplementation(async ({ message, options, initialValue }) => {
      lists[message] = options.map((o: { value: string }) => o.value);
      if (message === 'Region:') return initialValue;
      throw new Error('stop');
    });
    await gatherDeploymentConfig({ env: 'prod', ...mode }).catch(() => {});
    expect(lists['Region:']).toContain('us-iad');
    expect(lists['Region:']).not.toContain('us-east');
    expect(lists['Region:']).not.toContain('us-southeast');
    if ('ha' in mode) {
      const standby = lists['Standby region (HA failover target):'];
      expect(standby).toContain('us-ord');
      expect(standby).not.toContain('us-east');
      expect(standby).not.toContain('us-southeast');
    }
    clackMock.select.mockReset();
  });
});
