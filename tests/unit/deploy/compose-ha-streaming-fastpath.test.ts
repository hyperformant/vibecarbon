/**
 * Compose-HA replication fast path (HA-correctness Task 8, M1).
 *
 * `configureStandbyReplication` wipes the standby's PGDATA and re-seeds it, so
 * a deploy must not run it against a standby that already streams from the
 * current primary (the k8s tier has always probed first). The probe is the
 * shared one: pg_stat_replication on the primary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: '' as string | false,
  commands: [] as string[],
  reseed: vi.fn(async () => true),
  primary: vi.fn(async () => {}),
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
  const rec = async (_ip: string, _k: string, command: unknown) => {
    h.commands.push(String(command));
    return String(command).includes('pg_stat_replication') ? h.state : '';
  };
  return { ...actual, sshRun: vi.fn(rec), sshRunAsync: vi.fn(rec), sshRunChecked: vi.fn(rec) };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    configurePrimaryReplication: h.primary,
    configureStandbyReplication: h.reseed,
  };
});

vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, (o: object) => unknown>;
  return {
    ...actual,
    probeStreaming: (opts: object) =>
      actual.probeStreaming({ ...opts, attempts: 1, sleep: async () => {} }),
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

const ctx = () =>
  ({
    projectConfig: { projectName: 'myapp' },
    environment: 'prod',
    primary: { ip: '203.0.113.10', stack: 'primary' },
    standby: { ip: '203.0.113.20', stack: 'standby' },
    sshKeyPath: '/tmp/never-used-key',
    onProgress: () => {},
  }) as Record<string, unknown>;

const run = () =>
  (
    COMPOSE_HA_EFFECTS as Record<string, (c: Record<string, unknown>) => Promise<void>>
  ).haConfigureReplication(ctx());

describe('compose-HA deploy: reseed only a standby that is not streaming', () => {
  beforeEach(() => {
    h.commands.length = 0;
    h.reseed.mockClear();
    h.primary.mockClear();
  });

  it('a streaming standby is left alone', async () => {
    h.state = 'streaming';
    await run();
    expect(h.primary).toHaveBeenCalledTimes(1);
    expect(h.reseed).not.toHaveBeenCalled();
  });

  it('a standby that is not streaming is reseeded once', async () => {
    h.state = '';
    await run();
    expect(h.reseed).toHaveBeenCalledTimes(1);
  });

  it('a catching-up standby is reseeded too: only streaming counts', async () => {
    h.state = 'catchup';
    await run();
    expect(h.reseed).toHaveBeenCalledTimes(1);
  });

  it('an unreadable primary reads as not streaming', async () => {
    h.state = false;
    await run();
    expect(h.reseed).toHaveBeenCalledTimes(1);
  });
});
