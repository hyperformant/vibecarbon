import { describe, expect, it, vi } from 'vitest';

// B0 — when the caller gives no secondaryRegion, compose-ha must pick the
// provider's default standby for the primary: a DIFFERENT region on the SAME
// continent (Provider.getDefaultStandbyRegion). The legacy
// COMPOSE_HA_FALLBACK_REGIONS list started at nbg1, so a US primary (ash/hil)
// silently got a transatlantic standby and every replication byte paid an
// Atlantic RTT. Latent in e2e (which always passes secondaryRegion) but a
// real customer footgun.

// Stop haProvisionServers right after the standby-region decision — the next
// statement is generateSSHKeyPair(), so a throwing mock keeps the test off
// the provisioning path (Pulumi, SSH, provider HTTP) entirely.
vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    generateSSHKeyPair: () => {
      throw new Error('STOP_AFTER_REGION_DECISION');
    },
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

async function standbyFor(region: string, secondaryRegion?: string) {
  const ctx: Record<string, unknown> = {
    projectConfig: { projectName: 'testapp' },
    environment: 'production',
    sshKeyPath: '/tmp/never-created',
    region,
    secondaryRegion,
    apiToken: 'test-token',
    imageRef: 'ghcr.io/owner/repo:tag',
    envConfig: { provider: 'hetzner' },
    onProgress: () => {},
  };
  await expect(COMPOSE_HA_EFFECTS.haProvisionServers(ctx)).rejects.toThrow(
    'STOP_AFTER_REGION_DECISION',
  );
  return ctx.standbyRegion;
}

describe('compose-ha default standby region', () => {
  it('keeps a US primary on the same continent (ash → hil, not nbg1)', async () => {
    expect(await standbyFor('ash')).toBe('hil');
  });

  it('matches getDefaultStandbyRegion for the EU default pairing (nbg1 → fsn1)', async () => {
    expect(await standbyFor('nbg1')).toBe('fsn1');
  });

  it('an explicit secondaryRegion always wins', async () => {
    expect(await standbyFor('ash', 'fsn1')).toBe('fsn1');
  });
});
