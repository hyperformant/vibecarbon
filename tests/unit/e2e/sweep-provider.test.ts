/**
 * The one orphan-sweep dispatch (tests/e2e/utils/sweep-provider.ts), shared by
 * the lifecycle's teardown, `iter-step destroy -purge` and sweep-project.
 *
 * Each provider's sweep is mocked: these prove the dispatch hands every
 * registry provider to its OWN sweep with its OWN token (one provider's token
 * never reaches another's API), and never defaults an unknown provider to a
 * cloud it isn't on (the 2026-08-07 wrong-cloud sweep).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../config.js';

const { calls, cleanCounts } = vi.hoisted(() => ({
  calls: [] as Array<{ provider: string; args: unknown[] }>,
  cleanCounts: () => ({
    servers: 0,
    volumes: 0,
    placementGroups: 0,
    firewalls: 0,
    floatingIps: 0,
    networks: 0,
    s3Buckets: 0,
    sshKeys: 0,
  }),
}));

const fakeSweep = (provider: string) =>
  vi.fn(async (...args: unknown[]) => {
    calls.push({ provider, args });
    return { counts: cleanCounts(), enumFailed: false, swept: provider };
  });

vi.mock('../../e2e/utils/sweep-hetzner.js', () => ({
  sweepOrphanedHetznerResources: fakeSweep('hetzner'),
}));
vi.mock('../../e2e/utils/sweep-digitalocean.js', () => ({
  sweepOrphanedDigitalOceanResources: fakeSweep('digitalocean'),
}));
vi.mock('../../e2e/utils/sweep-linode.js', () => ({
  sweepOrphanedLinodeResources: fakeSweep('linode'),
}));
vi.mock('../../e2e/utils/sweep-vultr.js', () => ({
  sweepOrphanedVultrResources: fakeSweep('vultr'),
}));
vi.mock('../../e2e/utils/sweep-scaleway.js', () => ({
  sweepOrphanedScalewayResources: fakeSweep('scaleway'),
}));

const { orphanTotal, sweepProjectOrphans } = await import('../../e2e/utils/sweep-provider.js');

const PROVIDERS = Object.keys(testConfig.e2e.providers);
const ENV = {
  VULTR_STORAGE_REGION: 'ewr',
  SCALEWAY_ACCESS_KEY: 'SCWACCESS',
  SCALEWAY_DEFAULT_PROJECT_ID: 'proj-1',
};

afterEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
});

describe('sweepProjectOrphans', () => {
  it.each(PROVIDERS)('%s goes to its own sweep, with its own token', async (provider) => {
    const out = await sweepProjectOrphans({
      tag: '[t]',
      provider,
      projectName: 'testapp-k8s-1-abc',
      token: `token-${provider}`,
      env: ENV,
    });
    expect(calls.map((c) => c.provider)).toEqual([provider]);
    expect((out as { swept?: string }).swept).toBe(provider);
    const [tag, projectName, third] = calls[0].args as [string, string, unknown];
    expect([tag, projectName]).toEqual(['[t]', 'testapp-k8s-1-abc']);
    const token = typeof third === 'string' ? third : (third as { token: string }).token;
    expect(token).toBe(`token-${provider}`);
  });

  it('hands the storage companions only to the sweeps that need them', async () => {
    for (const provider of ['vultr', 'scaleway']) {
      await sweepProjectOrphans({
        tag: '[t]',
        provider,
        projectName: 'testapp-x',
        token: 't',
        env: ENV,
      });
    }
    expect(calls[0].args[2]).toEqual({ token: 't', storageRegion: 'ewr' });
    expect(calls[1].args[2]).toEqual({
      token: 't',
      storageKey: 'SCWACCESS',
      projectId: 'proj-1',
    });
  });

  it('never defaults an unknown provider to another cloud', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await sweepProjectOrphans({
      tag: '[t]',
      provider: 'not-a-cloud',
      projectName: 'testapp-x',
      token: 't',
      env: ENV,
    });
    expect(calls).toEqual([]);
    // Nothing was checked, so it counts as an enumeration failure.
    expect(out.enumFailed).toBe(true);
    expect(orphanTotal(out.counts)).toBe(0);
    expect(String(warn.mock.calls[0]?.[0])).toContain('REGRESSION');
  });
});

describe('the registry names each compute token', () => {
  it.each(PROVIDERS)('%s has a computeTokenEnv that its requiredEnv also demands', (provider) => {
    const entry = (
      testConfig.e2e.providers as Record<
        string,
        { computeTokenEnv?: string; requiredEnv: string[] }
      >
    )[provider];
    expect(entry.computeTokenEnv).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(entry.requiredEnv).toContain(entry.computeTokenEnv);
  });
});

describe('orphanTotal', () => {
  it('counts every category, the optional ones too', () => {
    expect(orphanTotal(cleanCounts())).toBe(0);
    expect(orphanTotal({ ...cleanCounts(), volumes: 2, loadBalancers: 1, storageKeys: 1 })).toBe(4);
  });
});
