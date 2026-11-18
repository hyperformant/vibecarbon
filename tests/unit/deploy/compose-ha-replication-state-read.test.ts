/**
 * compose-ha's verify-streaming read takes only a real pg_stat_replication
 * state, as the k8s reader (readK8sReplicationState) does. `psql -tAc` prints
 * one token, a state or nothing; any other output (an ssh or docker error
 * banner) is a failed read, and so is the compose sshRun's `false`. Before,
 * the banner became the "last state" in the abort message and the recorded DR
 * posture, and a failed ssh read reported as "no replica connected".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/deploy/compose/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/deploy/compose/index.js')>()),
  sshRun: vi.fn(),
}));

const composeSsh = await import('../../../src/lib/deploy/compose/index.js');
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

const ctx = () =>
  ({
    projectConfig: { projectName: 'myapp' },
    primary: { ip: '1.1.1.1' },
    standby: { ip: '2.2.2.2' },
    sshKeyPath: '/k',
    allowDegraded: true,
    onProgress: () => {},
  }) as Record<string, unknown>;

/** The primary answers every pg_stat_replication read with `answer`. */
async function verifyWith(answer: string | false) {
  vi.mocked(composeSsh.sshRun).mockImplementation((async (_ip: string, _k: string, cmd: string) =>
    cmd.includes('pg_stat_replication') ? answer : '') as never);
  const c = ctx();
  vi.useFakeTimers();
  try {
    const done = COMPOSE_HA_EFFECTS.haVerifyStreaming(c);
    await vi.runAllTimersAsync();
    await done;
  } finally {
    vi.useRealTimers();
  }
  const reads = vi
    .mocked(composeSsh.sshRun)
    .mock.calls.filter((call) => String(call[2]).includes('pg_stat_replication'));
  return { c, reads: reads.length };
}

afterEach(() => {
  vi.mocked(composeSsh.sshRun).mockReset();
});

describe('compose-ha verify-streaming reads a state, or nothing', () => {
  it('an error banner is a failed read, never the last state', async () => {
    const banner = 'kex_exchange_identification: read: Connection reset by peer';
    const { c, reads } = await verifyWith(banner);
    expect(reads).toBe(10);
    expect(c.replActive).toBe(false);
    expect(c.degraded).toBe(true);
    expect(c.replLastState).toBe(
      `unreadable (could not query pg_stat_replication: could not read pg_stat_replication (unexpected output: ${banner}))`,
    );
  });

  it('a failed ssh read (false) is a failed read, never "no replica connected"', async () => {
    const { c, reads } = await verifyWith(false);
    expect(reads).toBe(10);
    expect(c.replActive).toBe(false);
    expect(String(c.replLastState)).toMatch(/^unreadable \(could not query pg_stat_replication: /);
  });

  it.each(['', 'startup', 'catchup', 'backup', 'stopping'])(
    'a real state (%j) is the last state, unchanged',
    async (state) => {
      const { c, reads } = await verifyWith(state);
      expect(reads).toBe(10);
      expect(c.replActive).toBe(false);
      expect(c.replLastState).toBe(state);
    },
  );

  it('streaming is streaming on the first read', async () => {
    vi.mocked(composeSsh.sshRun).mockImplementation((async (
      _ip: string,
      _k: string,
      cmd: string,
    ) => {
      if (cmd.includes('pg_stat_replication')) return 'streaming\n';
      if (cmd.includes('pg_control_system')) return 't|7412345678901234567|0/3000060|streaming|1';
      return '';
    }) as never);
    const c = ctx();
    await COMPOSE_HA_EFFECTS.haVerifyStreaming(c);
    expect(c.replActive).toBe(true);
    expect(c.replLastState).toBe('streaming');
  });
});
