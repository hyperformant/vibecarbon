/**
 * M1: the k8s restore's marker lifecycle and rollout wait.
 *
 * - The db rollout waits long enough for the staged fetch of THIS backup:
 *   max(DB_STS_BOOT_TIMEOUT_S, ceil(sizeBytes / 20 MiB/s)) seconds.
 * - The marker keys on vibecarbon-infra-secrets are cleared only after the
 *   pod is Ready, promoted and proven writable. Never in a `finally`: a
 *   cleared marker after a failed fetch made the next pod start boot whatever
 *   the failed restore left behind.
 * - A rollout failure leaves the keys set and names the init container's logs.
 * - The previous cluster ($PGDATA/.vc-prev) is removed only after promotion
 *   and the writable proof.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', () => ({
  getPostgresPod: vi.fn().mockResolvedValue('db-0'),
  sshKubectl: vi.fn(),
  sshRun: vi.fn().mockResolvedValue(''),
  getSSHKeyPath: vi.fn(),
}));

const { runK8sRestore } = await import('../../../src/restore.js');
const { RESTORE_MARKER_KEYS } = await import('../../../src/lib/walg/restore-marker.js');
const ssh = await import('../../../src/lib/ssh.js');

const BASE = {
  name: 'base_000000010000000000000002',
  timeline: 1,
  finishTime: new Date('2026-10-20T01:00:00Z'),
  sizeBytes: 40 * 1024 ** 3,
};

const s = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });

const args = (over: Record<string, unknown> = {}) => ({
  s: s(),
  chosenSource: { kind: 's3' as const, name: 'latest' },
  base: BASE,
  lineage: '7699032860122738725',
  envName: 'prod',
  serverIp: '10.0.1.1',
  sshKeyPath: '/tmp/key',
  envConfig: { deployMode: 'kubernetes' },
  readFreeBytes: async () => 500 * 1024 ** 3,
  ...over,
});

let events: string[];
let rolloutFails: boolean;

function patchOf(argv: string[]) {
  const i = argv.indexOf('-p');
  return JSON.parse(argv[i + 1]).stringData as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  rolloutFails = false;
  vi.mocked(ssh.sshKubectl).mockImplementation(async (_ip, _key, argv: string[]) => {
    const line = argv.join(' ');
    if (argv[0] === 'patch') {
      const data = patchOf(argv);
      events.push(data.RESTORE_BACKUP ? 'marker:set' : 'marker:clear');
    } else if (line.includes('rollout status statefulset/')) {
      events.push('rollout');
      if (rolloutFails) throw new Error('timed out waiting for the condition');
    } else if (line.includes('pg_is_in_recovery')) {
      return 'f';
    } else if (
      line.includes(
        'mv /var/lib/postgresql/data/.vc-prev /var/lib/postgresql/data/.vc-discard/prev.',
      )
    ) {
      events.push('retirePrev');
    } else if (line.includes('rm -rf /var/lib/postgresql/data/.vc-discard')) {
      events.push('rmDiscard');
    } else if (argv[0] === 'scale' && line.includes('--replicas=0')) {
      events.push('scaleDown');
    } else if (argv[0] === 'scale') {
      events.push('scaleUp');
    }
    return '';
  });
});

describe('runK8sRestore: the restore marker', () => {
  it('sets every marker key in one patch, with the named backup and rendered conf', async () => {
    await runK8sRestore(args({ assertWritable: async () => 'writable' }));
    const set = vi
      .mocked(ssh.sshKubectl)
      .mock.calls.map(([, , argv]) => argv as string[])
      .find((argv) => argv[0] === 'patch' && patchOf(argv).RESTORE_BACKUP);
    expect(set).toBeTruthy();
    const data = patchOf(set as string[]);
    expect(Object.keys(data).sort()).toEqual([...RESTORE_MARKER_KEYS].sort());
    expect(data.RESTORE_BACKUP).toBe(BASE.name);
    expect(data.RESTORE_TARGET).toBe('latest');
    // Each restore is its own attempt, and says it came from vibecarbon restore.
    expect(data.RESTORE_ATTEMPT).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.RESTORE_ORIGIN).toBe('restore');
    expect(data.RESTORE_RECOVERY_CONF).toContain("recovery_target_timeline = 'current'");
    expect(data.RESTORE_RECOVERY_CONF).toContain('-default_transaction_read_only');
  });

  it('clears the keys only after Ready and the writable proof, then removes .vc-prev', async () => {
    await runK8sRestore(
      args({
        assertWritable: async () => {
          events.push('writable');
          return 'writable';
        },
      }),
    );
    expect(events).toEqual([
      'marker:set',
      'scaleDown',
      'rollout',
      'writable',
      'retirePrev',
      'marker:clear',
      'rmDiscard',
      'scaleUp',
    ]);
  });

  it('a rollout failure leaves the keys set and names the init container logs', async () => {
    rolloutFails = true;
    await expect(runK8sRestore(args({ assertWritable: async () => 'writable' }))).rejects.toThrow(
      'kubectl logs db-0 -c walg-restore',
    );
    expect(events).not.toContain('marker:clear');
    expect(events).not.toContain('retirePrev');
  });

  it('a failed writable proof leaves the keys set and keeps .vc-prev', async () => {
    await expect(
      runK8sRestore(
        args({
          assertWritable: async () => {
            throw new Error('the primary is write-fenced and could not be lifted');
          },
        }),
      ),
    ).rejects.toThrow(/write-fenced/);
    expect(events).not.toContain('marker:clear');
    expect(events).not.toContain('retirePrev');
  });
});

describe('runK8sRestore: an unproven restore keeps the marker and .vc-prev (I4)', () => {
  it('an unreadable fence fails loudly, the keys stay set and the app stays down', async () => {
    const err = await runK8sRestore(args({ assertWritable: async () => 'unknown' })).catch(
      (e) => e,
    );
    const msg = String(err?.message);
    expect(msg).toMatch(/could not prove .* writable.*kept .*\.vc-prev/s);
    const check = msg.indexOf('SHOW default_transaction_read_only');
    const retire = msg.indexOf('mkdir -p /var/lib/postgresql/data/.vc-discard');
    const clear = msg.indexOf('"RESTORE_BACKUP":""');
    const remove = msg.indexOf('rm -rf /var/lib/postgresql/data/.vc-discard');
    const scale = msg.indexOf('--replicas=2');
    expect(check).toBeGreaterThan(-1);
    expect(msg).toMatch(/expect off/);
    expect(retire).toBeGreaterThan(check);
    expect(clear).toBeGreaterThan(retire);
    expect(remove).toBeGreaterThan(clear);
    expect(scale).toBeGreaterThan(remove);
    expect(msg).not.toMatch(/rm -rf \/var\/lib\/postgresql\/data\/\.vc-prev\b/);
    // One command per line, never chained with &&.
    expect(msg).not.toContain('&& kubectl');
    const lines = msg.split('\n').map((l) => l.trim());
    expect(
      lines.filter((l) => l.startsWith('kubectl -n vibecarbon')).length,
    ).toBeGreaterThanOrEqual(4);
    expect(events).not.toContain('marker:clear');
    expect(events).not.toContain('retirePrev');
    expect(events).not.toContain('scaleUp');
  });
});

describe('runK8sRestore: the staged fetch must fit (S1c)', () => {
  it('refuses before the marker or any scale when the volume lacks room', async () => {
    await expect(
      runK8sRestore(
        args({ readFreeBytes: async () => 10 * 1024 ** 3, assertWritable: async () => 'writable' }),
      ),
    ).rejects.toThrow(/refused before stopping anything/);
    expect(events).toEqual([]);
  });
});

describe('runK8sRestore: the rollout wait scales with the backup', () => {
  function rolloutCall() {
    return vi
      .mocked(ssh.sshKubectl)
      .mock.calls.find(([, , argv]) =>
        (argv as string[]).join(' ').includes('rollout status statefulset/'),
      );
  }

  it('a 40 GiB base waits ceil(size / 20 MiB/s) seconds', async () => {
    await runK8sRestore(args({ assertWritable: async () => 'writable' }));
    const call = rolloutCall();
    expect(call?.[2]).toContain('--timeout=2048s');
    expect(call?.[3]).toMatchObject({ timeout: (2048 + 30) * 1000 });
  });

  it('a small base keeps the DB_STS_BOOT_TIMEOUT_S floor', async () => {
    await runK8sRestore(
      args({ base: { ...BASE, sizeBytes: 1024 ** 2 }, assertWritable: async () => 'writable' }),
    );
    expect(rolloutCall()?.[2]).toContain('--timeout=600s');
  });
});
