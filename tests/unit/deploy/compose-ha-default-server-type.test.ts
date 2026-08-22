import { describe, expect, it, vi } from 'vitest';

// A8 RCA (2026-07-22): haProvisionServers' own `ctx.serverType ||
// Provider.DEFAULT_COMPOSE_TYPE` fallback is unreachable in a real deploy —
// the orchestrator's compose-ha ctx build (deploy/orchestrator.js) always
// pre-sets ctx.serverType via the SAME static before this effect runs. This
// pin exercises the effect directly (bypassing the orchestrator) so the
// fallback stays correct in isolation, and so a future edit that reintroduces
// a second `DEFAULT_COMPOSE_HA_TYPE`-style split is caught here rather than
// only surfacing as a live-deploy behavior drift.

// Stop haProvisionServers right after the server-type decision — the next
// meaningful step is the standby-region decision, then generateSSHKeyPair();
// a throwing mock keeps the test off the provisioning path (Pulumi, SSH,
// provider HTTP) entirely. Mirrors compose-ha-standby-region.test.ts.
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

async function serverTypeFor(ctxServerType?: string) {
  const ctx: Record<string, unknown> = {
    projectConfig: { projectName: 'testapp' },
    environment: 'production',
    sshKeyPath: '/tmp/never-created',
    region: 'nbg1',
    serverType: ctxServerType,
    apiToken: 'test-token',
    imageRef: 'ghcr.io/owner/repo:tag',
    envConfig: { provider: 'hetzner' },
    onProgress: () => {},
  };
  await expect(COMPOSE_HA_EFFECTS.haProvisionServers(ctx)).rejects.toThrow(
    'STOP_AFTER_SERVER_TYPE_DECISION',
  );
  return ctx.serverType;
}

describe('compose-ha effect server-type fallback', () => {
  it('falls back to Provider.DEFAULT_COMPOSE_TYPE when ctx.serverType is unset', async () => {
    expect(await serverTypeFor(undefined)).toBe(HetznerProvider.DEFAULT_COMPOSE_TYPE);
    expect(HetznerProvider.DEFAULT_COMPOSE_TYPE).toBe('cpx22');
  });

  it('an explicit ctx.serverType always wins', async () => {
    expect(await serverTypeFor('cpx31')).toBe('cpx31');
  });
});
