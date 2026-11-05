/**
 * compose-HA brings the WireGuard tunnel up early (same shape as k8s-ha's
 * `deploy.ha.replication.transportEarly`): as soon as the setup fan has opened
 * the WireGuard ports, the tunnel starts in the background and overlaps the
 * image pulls. The replication step awaits it instead of starting it, so the
 * 48 s of apt work on both nodes is no longer serial at the end of the deploy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  events: [] as string[],
  tunnel: vi.fn(),
  release: null as null | (() => void),
}));

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const quiet = () => {};
  return {
    ...actual,
    log: { info: quiet, warn: quiet, success: quiet, message: quiet, error: quiet, step: quiet },
  };
});

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // The first ssh after the tunnel is the primary-side replication work.
  const rec = async (_ip: string, _k: string, command: unknown) => {
    h.events.push('primaryAccess');
    // An already-streaming standby skips the reseed, which is not under test.
    return String(command).includes('pg_stat_replication') ? 'streaming' : '';
  };
  return {
    ...actual,
    sshRun: vi.fn(rec),
    sshRunAsync: vi.fn(rec),
    sshRunChecked: vi.fn(rec),
    setupServerFiles: vi.fn(async () => {}),
  };
});

vi.mock('../../../src/lib/deploy/wireguard.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, exchangeAndBringUpTunnel: h.tunnel };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    openWireguardPortUfw: vi.fn(async () => {}),
    openWireguardPortHetznerFirewall: vi.fn(async () => {}),
    configureStandbyReplication: vi.fn(async () => true),
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');
const E = COMPOSE_HA_EFFECTS as Record<string, (c: Record<string, unknown>) => Promise<void>>;

const ctx = (extra: Record<string, unknown> = {}) =>
  ({
    projectConfig: { projectName: 'myapp' },
    environment: 'prod',
    envConfig: {},
    primary: { ip: '203.0.113.10', stack: 'primary' },
    standby: { ip: '203.0.113.20', stack: 'standby' },
    sshKeyPath: '/tmp/never-used-key',
    onProgress: () => {},
    ...extra,
  }) as Record<string, unknown>;

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

describe('compose-HA early tunnel', () => {
  beforeEach(() => {
    h.events.length = 0;
    unhandled.length = 0;
    h.tunnel.mockReset();
    process.env.REPL_PASSWORD = 'test-repl-password';
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    delete process.env.REPL_PASSWORD;
  });

  it('starts the tunnel after the setup fan and the replication step awaits it', async () => {
    let finish!: () => void;
    h.tunnel.mockImplementation(async () => {
      h.events.push('tunnel:start');
      await new Promise<void>((r) => {
        finish = r;
      });
      h.events.push('tunnel:done');
    });
    const c = ctx();
    await E.haSetupServerFiles(c);
    // Started during the fan step, before the pull fan could even begin.
    expect(h.tunnel).toHaveBeenCalledTimes(1);
    h.events.push('pulls');

    const repl = E.haConfigureReplication(c);
    await new Promise((r) => setTimeout(r, 10));
    // The replication step is waiting on the early tunnel, not starting its own.
    expect(h.tunnel).toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain('primaryAccess');
    finish();
    await repl;
    expect(h.events.indexOf('tunnel:start')).toBeLessThan(h.events.indexOf('pulls'));
    expect(h.events.indexOf('tunnel:done')).toBeLessThan(h.events.indexOf('primaryAccess'));
    expect(h.tunnel).toHaveBeenCalledTimes(1);
  });

  it('a rejected early tunnel fails at the replication step, never unhandled', async () => {
    h.tunnel.mockRejectedValue(new Error('wg install failed on 203.0.113.10'));
    const c = ctx();
    await E.haSetupServerFiles(c);
    expect(h.tunnel).toHaveBeenCalledTimes(1);
    // Let the rejection settle with nobody awaiting it yet.
    await new Promise((r) => setTimeout(r, 20));
    await expect(E.haConfigureReplication(c)).rejects.toThrow('wg install failed on 203.0.113.10');
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
    expect(h.tunnel).toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain('primaryAccess');
  });

  it('a reconverge starts no early tunnel', async () => {
    h.tunnel.mockResolvedValue({});
    await E.haSetupServerFiles(ctx({ reconverge: { promoted: {}, retired: {} } }));
    expect(h.tunnel).not.toHaveBeenCalled();
  });

  it('with no early tunnel the replication step runs the tunnel itself, as before', async () => {
    h.tunnel.mockResolvedValue({});
    await E.haConfigureReplication(ctx());
    expect(h.tunnel).toHaveBeenCalledTimes(1);
    expect(h.events).toContain('primaryAccess');
  });
});
