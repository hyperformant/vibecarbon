/**
 * compose-ha programs take each server's type from its servers[] entry
 * (Task 7b). A compose scale resizes the primary, the standby or both, and
 * records the new type per server; a primary-only scale leaves the env-level
 * serverType alone. If the deploy's programs then asked for the env-level type,
 * `up` would resize the scaled server back (a reboot on every provider).
 *
 * Rule: a type this deploy was asked for (`deploy -server-type`, threaded as
 * ctx.serverTypeRequested) applies to both stacks, as before; otherwise each
 * stack keeps its server's recorded type.
 *
 * Same stop-early harness as compose-ha-standby-server-type.test.ts.
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

async function runDecision(
  serverType: string,
  envConfig: Record<string, unknown>,
  serverTypeRequested = false,
) {
  const ctx: Record<string, unknown> = {
    projectConfig: { projectName: 'testapp' },
    environment: 'production',
    sshKeyPath: '/tmp/never-created',
    region: 'nbg1',
    secondaryRegion: 'fsn1',
    serverType,
    serverTypeRequested,
    apiToken: 'test-token',
    imageRef: 'ghcr.io/owner/repo:tag',
    envConfig: { provider: 'hetzner', ...envConfig },
    onProgress: () => {},
  };
  await expect(COMPOSE_HA_EFFECTS.haProvisionServers(ctx)).rejects.toThrow(
    'STOP_AFTER_SERVER_TYPE_DECISION',
  );
  return ctx;
}

const servers = (primaryType: string, standbyType: string) => [
  { name: 'testapp-production-primary', role: 'primary', id: '1', serverType: primaryType },
  { name: 'testapp-production-standby', role: 'standby', id: '2', serverType: standbyType },
];

describe('compose-ha server type per stack, after a scale', () => {
  it('a primary-only scale: the primary stack keeps the scaled type, the standby its own', async () => {
    const ctx = await runDecision('cpx22', {
      serverType: 'cpx22',
      servers: servers('cpx42', 'cpx22'),
    });
    expect(ctx.primaryStackServerType).toBe('cpx42');
    expect(ctx.standbyServerType).toBe('cpx22');
  });

  it('after a failover the types follow the birth stack, not the role', async () => {
    const swapped = [
      { name: 'testapp-production-primary', role: 'standby', id: '1', serverType: 'cpx32' },
      { name: 'testapp-production-standby', role: 'primary', id: '2', serverType: 'cpx42' },
    ];
    const ctx = await runDecision('cpx22', { serverType: 'cpx22', servers: swapped });
    expect(ctx.primaryStackServerType).toBe('cpx32');
    expect(ctx.standbyServerType).toBe('cpx42');
  });

  it('a type this deploy asks for applies to both stacks, as before', async () => {
    const ctx = await runDecision(
      'cpx52',
      { serverType: 'cpx22', servers: servers('cpx42', 'cpx22') },
      true,
    );
    expect(ctx.primaryStackServerType).toBe('cpx52');
    expect(ctx.standbyServerType).toBe('cpx52');
  });

  it('a requested type equal to the env type still applies: -server-type cpx22 resizes the scaled primary back', async () => {
    const ctx = await runDecision(
      'cpx22',
      { serverType: 'cpx22', servers: servers('cpx42', 'cpx22') },
      true,
    );
    expect(ctx.primaryStackServerType).toBe('cpx22');
    expect(ctx.standbyServerType).toBe('cpx22');
  });

  it('no -server-type: a differing env type never overrides the recorded ones', async () => {
    const ctx = await runDecision('cpx52', {
      serverType: 'cpx22',
      servers: servers('cpx42', 'cpx32'),
    });
    expect(ctx.primaryStackServerType).toBe('cpx42');
    expect(ctx.standbyServerType).toBe('cpx32');
  });

  it('a first deploy (no servers recorded) takes the env type', async () => {
    const ctx = await runDecision('cpx22', {});
    expect(ctx.primaryStackServerType).toBe('cpx22');
    expect(ctx.standbyServerType).toBe('cpx22');
  });
});
