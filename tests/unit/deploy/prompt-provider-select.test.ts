/**
 * Unit tests for the cloud-provider select added to the new-environment
 * wizard (lib/deploy/prompts.js): resolveProvider (the select itself) and
 * assertValidRegionFlag (the -region guard shared between the pre-select
 * check and the post-select re-check in gatherDeploymentConfig — see its
 * "Resolved once per flow" comment). Also pins the gate interaction with
 * resolveDeployMode (A2's SUPPORTED_TIERS mode filter), which must use the
 * POST-SELECT provider so selecting a compose-only provider (Linode) hides
 * the k8s modes while Hetzner and DigitalOcean keep all four (d4 lift).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  note: vi.fn(),
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

import {
  assertValidRegionFlag,
  resolveDeployMode,
  resolveProvider,
} from '../../../src/lib/deploy/prompts.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { resolveS3RegionFor } from '../../../src/lib/providers/index.js';

const noFlags = { compose: false, k8s: false, ha: false, yes: false };

describe('resolveProvider', () => {
  afterEach(() => {
    clackMock.select.mockReset();
  });

  it('skips the select for an already-bound environment (envConfig.provider present)', async () => {
    const result = await resolveProvider(noFlags, { provider: 'digitalocean' });
    expect(result.Provider).toBe(DigitalOceanProvider);
    expect(result.envConfig.provider).toBe('digitalocean');
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('skips the select for a legacy environment (deployMode set, provider never persisted)', async () => {
    // Pre-multi-provider environments have deployMode/status/servers but no
    // `provider` field. Must fall back to hetzner silently — not re-prompt
    // an operator whose environment is already deployed. Regression: this
    // exact shape (deployMode set, provider absent) is what the license-gate
    // integration fixtures use, and an earlier version of this guard keyed
    // only on `provider`, wrongly prompting here.
    const result = await resolveProvider(noFlags, {
      deployMode: 'compose-ha',
      status: 'deployed',
      servers: [{ ip: '10.0.0.1' }],
    });
    expect(result.Provider).toBe(HetznerProvider);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('errors (exit 1) under -y for a NEW environment with no -provider — listing the registry options instead of silently defaulting', async () => {
    // Owner decision 2026-08-08: a fresh environment's provider is the most
    // consequential binding it has — automation must say it out loud, same
    // silent-default class the de-defaulting audits eliminated elsewhere.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(resolveProvider({ ...noFlags, yes: true }, {})).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(clackMock.log.error).toHaveBeenCalledWith(
      expect.stringContaining('-provider <hetzner|digitalocean|linode|vultr|scaleway>'),
    );
    expect(clackMock.select).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('-provider satisfies -y on a new environment and binds it', async () => {
    const result = await resolveProvider({ ...noFlags, yes: true, provider: 'linode' }, {});
    expect(result.envConfig.provider).toBe('linode');
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('-provider seeds the choice interactively too — no select shown', async () => {
    const result = await resolveProvider({ ...noFlags, provider: 'digitalocean' }, {});
    expect(result.Provider).toBe(DigitalOceanProvider);
    expect(result.envConfig.provider).toBe('digitalocean');
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('invalid -provider errors (exit 1) listing the registry options', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(resolveProvider({ ...noFlags, provider: 'atlantis' }, {})).rejects.toThrow(
      'process.exit(1)',
    );
    expect(clackMock.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown provider 'atlantis'"),
    );
    exitSpy.mockRestore();
  });

  it('-provider conflicting with an existing binding errors loudly (never silently ignored)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(
      resolveProvider({ ...noFlags, provider: 'linode' }, { provider: 'hetzner' }),
    ).rejects.toThrow('process.exit(1)');
    expect(clackMock.log.error).toHaveBeenCalledWith(expect.stringContaining('bound to hetzner'));
    exitSpy.mockRestore();
  });

  it('-provider matching the existing binding proceeds silently', async () => {
    const result = await resolveProvider(
      { ...noFlags, provider: 'digitalocean' },
      { provider: 'digitalocean' },
    );
    expect(result.Provider).toBe(DigitalOceanProvider);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('prompts with hetzner first/default and DigitalOcean labeled by name only (no subordinating framing)', async () => {
    clackMock.select.mockResolvedValueOnce('hetzner');
    await resolveProvider(noFlags, {});

    expect(clackMock.select).toHaveBeenCalledTimes(1);
    const call = clackMock.select.mock.calls[0][0];
    expect(call.options.map((o: { value: string }) => o.value)).toEqual([
      'hetzner',
      'digitalocean',
      'linode',
      'vultr',
      'scaleway',
    ]);
    expect(call.options[0].label).toBe('Hetzner Cloud');
    expect(call.options[1].label).toBe('DigitalOcean');
    expect(call.options[2].label).toBe('Linode');
    expect(call.options[3].label).toBe('Vultr');
    expect(call.options[4].label).toBe('Scaleway');
    expect(call.initialValue).toBe('hetzner');
  });

  it('selecting hetzner interactively is byte-identical to the unset default', async () => {
    clackMock.select.mockResolvedValueOnce('hetzner');
    const result = await resolveProvider(noFlags, {});
    expect(result.Provider).toBe(HetznerProvider);
    expect(result.envConfig.provider).toBe('hetzner');
  });

  it('selecting digitalocean resolves the DigitalOcean provider + regions', async () => {
    clackMock.select.mockResolvedValueOnce('digitalocean');
    const result = await resolveProvider(noFlags, {});
    expect(result.Provider).toBe(DigitalOceanProvider);
    expect(result.envConfig.provider).toBe('digitalocean');
    expect(result.Provider.REGIONS).toBe(DigitalOceanProvider.REGIONS);
    expect(Object.keys(result.Provider.REGIONS)).toContain('nyc3');
    expect(Object.keys(result.Provider.REGIONS)).not.toContain('hel1');
  });

  it('selecting digitalocean seeds the DigitalOcean Spaces S3 region', async () => {
    clackMock.select.mockResolvedValueOnce('digitalocean');
    const result = await resolveProvider(noFlags, {});
    const s3Region = await resolveS3RegionFor(result.envConfig.provider, 'nyc3');
    expect(s3Region).toBe('nyc3');
  });

  it('exits 130 when the select is cancelled', async () => {
    clackMock.select.mockResolvedValueOnce(Symbol.for('cancel'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(resolveProvider(noFlags, {})).rejects.toThrow('process.exit(130)');
    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(clackMock.cancel).toHaveBeenCalledWith('Operation cancelled.');
    exitSpy.mockRestore();
  });
});

describe('assertValidRegionFlag', () => {
  afterEach(() => {
    clackMock.log.error.mockClear();
  });

  it('does nothing when no -region flag was supplied', () => {
    expect(() => assertValidRegionFlag({ region: null }, HetznerProvider)).not.toThrow();
  });

  it('does nothing when -region is valid for the given provider', () => {
    expect(() => assertValidRegionFlag({ region: 'hel1' }, HetznerProvider)).not.toThrow();
  });

  it('exits 1 with a loud error when -region is invalid for the given provider', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    expect(() => assertValidRegionFlag({ region: 'atlantis' }, HetznerProvider)).toThrow(
      'process.exit(1)',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(clackMock.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown region 'atlantis' for Hetzner Cloud"),
    );
    exitSpy.mockRestore();
  });

  it('pins the carry-forward case: -region hel1 (valid for Hetzner) rejected for DigitalOcean post-select', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    // hel1 is a real Hetzner region and would pass the FIRST (pre-select)
    // guard, resolved against the hetzner default. After the wizard's
    // provider select resolves to DigitalOcean, the re-check must reject it
    // loudly against DigitalOcean's own region list — not silently pass
    // through the earlier, now-stale, Hetzner-based check.
    expect(() => assertValidRegionFlag({ region: 'hel1' }, DigitalOceanProvider)).toThrow(
      'process.exit(1)',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(clackMock.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown region 'hel1' for DigitalOcean"),
    );
    exitSpy.mockRestore();
  });
});

describe('gate interaction: resolveDeployMode filters by the POST-SELECT provider', () => {
  afterEach(() => {
    clackMock.select.mockReset();
  });

  it('keeps all four deploy-mode options for digitalocean (d4 lift: DO supports k8s-ha)', async () => {
    clackMock.select.mockResolvedValueOnce('digitalocean'); // provider select
    const { envConfig } = await resolveProvider(noFlags, {});
    expect(envConfig.provider).toBe('digitalocean');

    clackMock.select.mockResolvedValueOnce('compose'); // deploy-mode select
    const result = await resolveDeployMode(noFlags, envConfig);
    expect(result).toEqual({ deployMode: 'compose', ha: false });

    const modeCall = clackMock.select.mock.calls[1][0];
    const modeValues = modeCall.options.map((o: { value: string }) => o.value);
    expect(modeValues).toEqual(['compose', 'compose-ha', 'kubernetes', 'kubernetes-ha']);
  });

  it('keeps all four deploy-mode options for hetzner', async () => {
    clackMock.select.mockResolvedValueOnce('hetzner'); // provider select
    const { envConfig } = await resolveProvider(noFlags, {});

    clackMock.select.mockResolvedValueOnce('compose'); // deploy-mode select
    await resolveDeployMode(noFlags, envConfig);

    const modeCall = clackMock.select.mock.calls[1][0];
    expect(modeCall.options.map((o: { value: string }) => o.value)).toEqual([
      'compose',
      'compose-ha',
      'kubernetes',
      'kubernetes-ha',
    ]);
  });
});
