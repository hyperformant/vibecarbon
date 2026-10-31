/**
 * The deploy wizard sizes a new environment from the role defaults
 * (getRegionDefaults, src/lib/sizing.js): compose takes `composeType`, the
 * cheapest orderable 4 GB+ server in the region, never the 2 GB k8s db
 * default. A type the env already has on record (a flag or .vibecarbon.json)
 * always wins, even when the catalog now has a cheaper one: a rerun never
 * resizes behind the operator's back.
 *
 * When the region has nothing orderable for a role, the wizard refuses with
 * one line naming the cause and the cheapest same-continent regions that do
 * have it (ruling B6: fail closed, never fall to a pricier type), before it
 * asks for the S3 keys or anything is created.
 *
 * Harness as in prompt-credential-order.test.ts, with the provider seeded
 * from a dated catalog fixture instead of a stubbed getRegionDefaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

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

const disk = vi.hoisted(() => ({ envConfig: {} as Record<string, unknown> }));
vi.mock('../../../src/lib/config.js', () => ({
  loadProjectConfig: () => ({
    projectName: 'sizeapp',
    bucketSalt: 'abc123',
    environments: { prod: disk.envConfig },
  }),
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
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

const providerWrites: string[] = [];
const restores: Array<() => void> = [];

function seed(...args: Parameters<typeof seedCatalog>) {
  restores.push(seedCatalog(...args));
}

/** Run the wizard for env `prod` with `envConfig` on record. */
function runPrompts({
  provider = 'hetzner',
  mode = 'compose',
  args = {},
  envConfig = {},
}: {
  provider?: string;
  mode?: 'compose' | 'k8s';
  args?: Record<string, unknown>;
  envConfig?: Record<string, unknown>;
}) {
  disk.envConfig = envConfig;
  return gatherDeploymentConfig({ env: 'prod', provider, [mode]: true, ...args });
}

describe('deploy wizard default sizes', () => {
  beforeEach(() => {
    providerWrites.length = 0;
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    for (const P of [HetznerProvider, DigitalOceanProvider]) {
      vi.spyOn(P, 'promptApiToken').mockResolvedValue('a'.repeat(64));
      // The seeded catalog stands in for the live fetch.
      vi.spyOn(P, 'fetchServerTypes').mockResolvedValue(undefined as never);
      vi.spyOn(P, 'promptObjectStorageCredentials').mockImplementation(async () => {
        providerWrites.push('s3-credentials-asked');
        return { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40), source: 'prompt' };
      });
    }
    vi.spyOn(HetznerProvider.prototype, 'createServer').mockImplementation(async () => {
      providerWrites.push('createServer');
      return {} as never;
    });
    vi.spyOn(S3CompatibleProvider.prototype, 'createBucket').mockImplementation(async () => {
      providerWrites.push('createBucket');
      return {} as never;
    });
    vi.spyOn(S3CompatibleProvider.prototype, 'validateCredentials').mockResolvedValue({
      valid: true,
    });
    seed(HetznerProvider, '2026-10-22/hetzner');
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    vi.restoreAllMocks();
    clackMock.log.error.mockClear();
    clackMock.log.info.mockClear();
  });

  it('compose with no args or envConfig sizes takes composeType', async () => {
    const out = await runPrompts({ args: { yes: true, region: 'nbg1' }, envConfig: {} });
    expect(out.serverType).toBe('cpx22');
    expect(out.dbServerType).toBe('cpx22'); // the one host, never the 2 GB k8s db default
  });

  it('Review Focus 1: persisted types win', async () => {
    expect(
      (
        await runPrompts({
          args: { yes: true },
          envConfig: { region: 'nbg1', serverType: 'cpx32' },
        })
      ).serverType,
    ).toBe('cpx32');
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const k8s = await runPrompts({
      provider: 'digitalocean',
      mode: 'k8s',
      args: { yes: true },
      envConfig: { region: 'nyc3', masterServerType: 's-2vcpu-2gb' },
    });
    expect(k8s.masterServerType).toBe('s-2vcpu-2gb');
  });

  it('a rerun keeps the recorded type when the catalog now has a cheaper one', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    // cx23 is the cheapest compose server in hel1 in this catalog...
    expect(HetznerProvider.getRegionDefaults('hel1').composeType).toBe('cx23');
    // ...but the env picked cpx22 on its first try, and keeps it.
    const out = await runPrompts({
      args: { yes: true },
      envConfig: { region: 'hel1', serverType: 'cpx22' },
    });
    expect(out.serverType).toBe('cpx22');
  });

  it('P7: nothing orderable refuses before any provider write', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1', { drop: { nbg1: ['cpx22', 'cpx21'] } });
    await expect(
      runPrompts({ args: { yes: true, region: 'nbg1' }, envConfig: {} }),
    ).rejects.toThrow(/exit 1/);
    expect(clackMock.log.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^no compose server with 4 GB\+ RAM is orderable in nbg1 right now; orderable nearby: hel1 \(cx23 \$7\.09\/mo\)/,
      ),
    );
    expect(providerWrites).toEqual([]);
  });

  it('P7: the refusal is one line, names at most 3 same-continent regions, and gives the command on its own line', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1', { drop: { nbg1: ['cpx22', 'cpx21'] } });
    await expect(
      runPrompts({ args: { yes: true, region: 'nbg1' }, envConfig: {} }),
    ).rejects.toThrow(/exit 1/);
    const line = String(clackMock.log.error.mock.calls[0][0]);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('a'.repeat(64)); // never the API token
    expect(line).not.toContain('—');
    expect(line).toBe(
      'no compose server with 4 GB+ RAM is orderable in nbg1 right now; ' +
        'orderable nearby: hel1 (cx23 $7.09/mo), fsn1 (cpx22 $23.59/mo)',
    );
    const hint = String(clackMock.log.info.mock.calls.at(-1)?.[0]);
    expect(hint.split('\n').at(-1)).toBe('  vibecarbon deploy prod -region hel1');
  });

  it('P7: a US region names only US regions', async () => {
    seed(HetznerProvider, '2026-10-22/hetzner', { drop: { ash: ['cpx22', 'cx23', 'cpx21'] } });
    await expect(runPrompts({ args: { yes: true, region: 'ash' }, envConfig: {} })).rejects.toThrow(
      /exit 1/,
    );
    const line = String(clackMock.log.error.mock.calls[0][0]);
    expect(line).toMatch(
      /^no compose server with 4 GB\+ RAM is orderable in ash right now; orderable nearby: hil \(/,
    );
    expect(line).not.toMatch(/nbg1|fsn1|hel1/);
  });

  it('P7: nothing nearby either says so and points at -server-type', async () => {
    const eu = {
      nbg1: ['cpx22', 'cx23', 'cpx21'],
      fsn1: ['cpx22', 'cx23', 'cpx21'],
      hel1: ['cpx22', 'cx23', 'cpx21'],
    };
    seed(HetznerProvider, '2026-10-22/hetzner', { drop: eu });
    await expect(
      runPrompts({ args: { yes: true, region: 'nbg1' }, envConfig: {} }),
    ).rejects.toThrow(/exit 1/);
    expect(String(clackMock.log.error.mock.calls[0][0])).toBe(
      'no compose server with 4 GB+ RAM is orderable in nbg1 right now, ' +
        'and none is orderable in the other regions on this continent either',
    );
    const hint = String(clackMock.log.info.mock.calls.at(-1)?.[0]);
    expect(hint.split('\n').at(-1)).toBe('  vibecarbon deploy prod -server-type <type>');
    expect(providerWrites).toEqual([]);
  });

  it('P7: k8s names the role with nothing orderable and prices the whole cluster nearby', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1', {
      drop: { nbg1: ['cpx12', 'cx23', 'cpx22', 'cpx11', 'cpx21'] },
    });
    await expect(
      runPrompts({ mode: 'k8s', args: { yes: true, region: 'nbg1' }, envConfig: {} }),
    ).rejects.toThrow(/exit 1/);
    const line = String(clackMock.log.error.mock.calls[0][0]);
    expect(line).toMatch(
      /^no k8s master server with 4 GB\+ RAM is orderable in nbg1 right now; orderable nearby: hel1 \(cx23 \+ \w+ \+ cx23 \$\d+\.\d\d\/mo\)/,
    );
    expect(providerWrites).toEqual([]);
  });
});
