/**
 * The compose-ha standby's location and type, as the effect decides them.
 *
 * With no standby location given, the effect's own default fits the
 * primary's type, as the deploy wizard's does: a standby location that does
 * not stock the primary's size is passed over, never handed a smaller box.
 *
 * Stop-early harness as in compose-ha-scaled-server-type.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

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

async function runDecision(fields: Record<string, unknown>) {
  const ctx: Record<string, unknown> = {
    projectConfig: { projectName: 'testapp' },
    environment: 'production',
    sshKeyPath: '/tmp/never-created',
    region: 'nbg1',
    apiToken: 'test-token',
    imageRef: 'ghcr.io/owner/repo:tag',
    envConfig: { provider: 'hetzner' },
    onProgress: () => {},
    ...fields,
  };
  await expect(COMPOSE_HA_EFFECTS.haProvisionServers(ctx)).rejects.toThrow(
    'STOP_AFTER_SERVER_TYPE_DECISION',
  );
  return ctx;
}

describe('compose-ha standby default location', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("fits the primary's type, as the wizard's default does", async () => {
    // fsn1 is out of cpx32 (8 GB); hel1 stocks it.
    restore = seedCatalog(HetznerProvider, '2026-10-22/hetzner', { drop: { fsn1: ['cpx32'] } });
    const ctx = await runDecision({ serverType: 'cpx32' });
    expect(ctx.standbyRegion).toBe('hel1');
    expect(ctx.standbyServerType).toBe('cpx32');
    expect(HetznerProvider.getDefaultStandbyRegion('nbg1', ['compose'], { compose: 'cpx32' })).toBe(
      'hel1',
    );
  });
});
