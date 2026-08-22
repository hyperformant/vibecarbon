import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RCA 2026-07-17 e4 run 4: the post-failover reconverge deploy REPLACED all
 * servers of BOTH clusters. deployK3s's k3s-infra block built its Pulumi
 * program without replaying the stack's existing k3sToken; the token is
 * interpolated into every node's userData, userData is immutable, so a fresh
 * token on an existing stack plans a full-cluster replace (etcd + PVC data
 * loss). The role reconciler makes cross-role re-runs of that block routine.
 * resolveStackK3sToken must recover the stored token; only a fresh stack may
 * mint one.
 */

const getStackOutputs = vi.fn();

vi.mock('../../../src/lib/iac/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/iac/index.js')>();
  return { ...real, getStackOutputs };
});

const FakeProvider = {
  getK8sProgram: vi.fn(async () => ({ fake: 'program' })),
};

describe('resolveStackK3sToken', () => {
  beforeEach(() => {
    getStackOutputs.mockReset();
    FakeProvider.getK8sProgram.mockClear();
  });

  const load = async () => {
    const mod = await import('../../../src/lib/deploy/k8s/k3s.js');
    return mod.resolveStackK3sToken;
  };

  it('replays the token from an existing stack', async () => {
    getStackOutputs.mockResolvedValueOnce({ k3sToken: 'stack-token-abc', masterIp: '1.2.3.4' });
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(
      FakeProvider,
      { environment: 'e4-primary' },
      { log: vi.fn() },
    );
    expect(token).toBe('stack-token-abc');
    expect(getStackOutputs).toHaveBeenCalledWith(
      'e4-primary',
      { fake: 'program' },
      expect.anything(),
    );
  });

  it('returns undefined (fresh-stack path) on empty outputs, loudly', async () => {
    getStackOutputs.mockResolvedValueOnce({});
    const log = vi.fn();
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(FakeProvider, { environment: 'e4-standby' }, { log });
    expect(token).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fresh token'));
  });

  it('degrades to fresh-stack behavior when the probe throws (never propagates)', async () => {
    getStackOutputs.mockRejectedValueOnce(new Error('NoSuchBucket: state backend gone'));
    const log = vi.fn();
    const resolveStackK3sToken = await load();
    const token = await resolveStackK3sToken(FakeProvider, { environment: 'e4-primary' }, { log });
    expect(token).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('errored'));
  });

  // M3 Task 9a (DO k8s 401 RCA): buildEnv now throws when a providerToken is
  // passed without a provider id (no more silent 'hetzner' default), so this
  // probe call MUST forward opts.provider through to getStackOutputs or a
  // DigitalOcean k3s-infra probe would 401/throw instead of degrading to the
  // fresh-token path.
  it('forwards opts.provider into the getStackOutputs probe call', async () => {
    getStackOutputs.mockResolvedValueOnce({ k3sToken: 'stack-token-abc' });
    const resolveStackK3sToken = await load();
    await resolveStackK3sToken(
      FakeProvider,
      { environment: 'd3' },
      { log: vi.fn(), provider: 'digitalocean', providerToken: 'do-secret-token' },
    );
    expect(getStackOutputs).toHaveBeenCalledWith(
      'd3',
      { fake: 'program' },
      expect.objectContaining({ provider: 'digitalocean', providerToken: 'do-secret-token' }),
    );
  });
});

describe('deployK3s wires the replayed token into the real program', () => {
  it('k3s-infra block calls resolveStackK3sToken and spreads the token', () => {
    // Source-level lockstep guard (same style as the walg-prefix and
    // node-ip guards): the helper is only load-bearing if the k3s-infra
    // block actually consumes it before building the program.
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(src).toMatch(/resolveStackK3sToken\(Provider, programConfig/);
    expect(src).toMatch(/\.\.\.\(priorK3sToken \? \{ k3sToken: priorK3sToken \} : \{\}\)/);
  });

  // M3 Task 9a (DO k8s 401 RCA): the k3s-infra block's two IaC calls
  // (resolveStackK3sToken's probe + the real upStack) both carry
  // `providerToken: options.apiToken`. buildEnv now throws unless a
  // `provider` id rides alongside that token, so both call sites must pass
  // one explicitly (providerIdFor(options), which defaults to 'hetzner'
  // the same way providerFor(options) already does for the Provider class
  // resolved two lines above) — a caller that forgets it turns every
  // DigitalOcean k8s deploy into an immediate throw instead of a live 401.
  it('threads provider explicitly into both k3s-infra IaC calls', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(src).toMatch(
      /resolveStackK3sToken\(Provider, programConfig, \{\s*provider: providerIdFor\(options\),/,
    );
    expect(src).toMatch(
      /upStack\(options\.environment, program, \{\s*provider: providerIdFor\(options\),/,
    );
  });
});
