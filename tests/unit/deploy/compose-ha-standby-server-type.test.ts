/**
 * compose-HA must resolve the STANDBY's server type for the STANDBY's region.
 *
 * k8s-ha has always done this (effects/k8s-ha.js): an SKU stocked where the
 * primary lives is not necessarily stocked in the standby's region, and plan
 * availability FLUXES — Vultr's per-region plan list moved twice inside one
 * week (2026-08-08 vs 2026-08-19). compose-ha passed the primary's type
 * straight through to both stacks, so a DEFAULT deploy could place the primary
 * and then fail the standby, naming a region the operator never picked
 * (getDefaultStandbyRegion chose it).
 *
 * Same stop-early harness as compose-ha-default-server-type.test.ts: throwing
 * from generateSSHKeyPair halts the effect right after the server-type and
 * standby-region decisions, keeping the test off Pulumi/SSH/provider HTTP.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    generateSSHKeyPair: () => {
      throw new Error('STOP_AFTER_SERVER_TYPE_DECISION');
    },
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');

async function runDecision(opts: { serverType?: string; region?: string; secondary?: string }) {
  const ctx: Record<string, unknown> = {
    projectConfig: { projectName: 'testapp' },
    environment: 'production',
    sshKeyPath: '/tmp/never-created',
    region: opts.region ?? 'nbg1',
    secondaryRegion: opts.secondary,
    serverType: opts.serverType,
    apiToken: 'test-token',
    imageRef: 'ghcr.io/owner/repo:tag',
    envConfig: { provider: 'hetzner' },
    onProgress: () => {},
  };
  await expect(COMPOSE_HA_EFFECTS.haProvisionServers(ctx)).rejects.toThrow(
    'STOP_AFTER_SERVER_TYPE_DECISION',
  );
  return ctx;
}

describe('compose-ha standby server type', () => {
  it('routes the standby type through resolveServerTypeForRegion for the STANDBY region', async () => {
    // The bug was that this was never called at all — the primary's type went
    // to both stacks. Pin the call AND its arguments.
    const spy = vi.spyOn(HetznerProvider, 'resolveServerTypeForRegion');
    try {
      const ctx = await runDecision({ serverType: 'cpx31', region: 'nbg1' });
      expect(spy).toHaveBeenCalledWith('cpx31', ctx.standbyRegion);
      // Never the PRIMARY's region — that would resolve the wrong catalogue.
      expect(spy).not.toHaveBeenCalledWith('cpx31', 'nbg1');
    } finally {
      spy.mockRestore();
    }
  });

  it('exposes the resolved type on ctx so later effects and config agree', async () => {
    const ctx = await runDecision({ serverType: 'cpx31' });
    expect(ctx.standbyServerType).toBeTruthy();
    expect(typeof ctx.standbyServerType).toBe('string');
  });

  it('leaves the PRIMARY type untouched', async () => {
    // Resolution is standby-only: the primary's region already stocks what the
    // operator asked for, and silently rewriting it would be a surprise.
    //
    // Deliberately uses an input the resolver CHANGES (cax11 -> x86). With a
    // type that resolves to itself this assertion passes even when the code
    // overwrites ctx.serverType, so it proved nothing — caught by mutating the
    // effect to assign both.
    const ctx = await runDecision({ serverType: 'cax11' });
    expect(ctx.standbyServerType).not.toBe('cax11');
    expect(ctx.serverType).toBe('cax11');
  });

  it('carries the ARM->x86 rescue onto the standby (amd64-only product)', async () => {
    // Belt-and-braces — the deploy prompt's assertAmd64ServerType normally
    // stops ARM earlier — but if one ever reaches here the standby must not be
    // provisioned on an arch the app image cannot run.
    const ctx = await runDecision({ serverType: 'cax11' });
    expect(String(ctx.standbyServerType).startsWith('cax')).toBe(false);
  });
});
