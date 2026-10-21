import { beforeEach, describe, expect, it, vi } from 'vitest';

// restoreCompose's order around the staged fetch (H2a, S1c, C1, I2, I4):
//   - a backup too big for the volume's free space refuses before anything stops;
//   - the fetch runs once per call (no transport re-run of a restore that may
//     still be running), with a timeout sized from the backup;
//   - a fetch that fails removes its run container, then brings the untouched
//     pre-restore database back up only when no swap was left half done;
//   - the previous cluster goes only after promotion AND a writable proof:
//     first renamed to .vc-discard (so a surviving .vc-prev always means
//     "unproven"), then removed; an unreadable fence keeps it and fails loudly.

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/command.js')>();
  return { ...actual, runCommandAsync: vi.fn() };
});
vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/ssh.js')>();
  return { ...actual, sshRunScript: vi.fn(async () => '') };
});

import { runCommandAsync } from '../../../src/lib/command.js';
import { restoreCompose } from '../../../src/lib/deploy/compose/index.js';

const BASE = {
  backup: 'base_000000010000000000000002',
  lineage: '7699032860122738725',
  target: 'latest',
  recoveryConf: '-restore_command\nrestore_command = \'wal-g wal-fetch "%f" "%p"\'',
};
const writable = async () => 'writable' as const;

let events: string[];
let fetchError: Error | null;
let freeKb: string;
let probeState: 'absent' | 'present' | 'swapped' | 'swapped-empty';
let stopError: Error | null;
let orphan: boolean;
let commands: string[];
let fetchOpts: Array<Record<string, unknown>>;

function label(cmd: string): string | null {
  if (cmd.includes('df -Pk')) return 'df';
  if (cmd.includes('docker compose stop db')) return 'stopDb';
  if (cmd.includes('bash /restore.sh')) return 'fetch';
  if (cmd.includes('docker ps -aq') && cmd.includes('proj-db-restore')) return 'orphanCheck';
  if (cmd.includes('docker rm -f proj-db-restore')) return 'rmRunContainer';
  if (/rm -f \/opt\/proj\/restore-walg\.[0-9a-f]+\.sh/.test(cmd)) return 'rmScript';
  if (cmd.includes('.vc-restore-in-progress')) return 'probeMarker';
  if (cmd.includes('docker compose start db && docker compose start app')) return 'restartOld';
  if (cmd.includes('docker compose start db')) return 'startDb';
  if (cmd.includes('pg_is_in_recovery')) return 'promoted';
  if (
    cmd.includes('mv /var/lib/postgresql/data/.vc-prev /var/lib/postgresql/data/.vc-discard/prev.')
  )
    return 'retirePrev';
  if (cmd.includes('rm -rf /var/lib/postgresql/data/.vc-discard')) return 'rmDiscard';
  if (/psql\b.*\bANALYZE\b/.test(cmd)) return 'analyze';
  if (cmd.includes('docker compose start app')) return 'startApp';
  return null;
}

beforeEach(() => {
  events = [];
  fetchError = null;
  freeKb = '';
  probeState = 'absent';
  stopError = null;
  orphan = false;
  commands = [];
  fetchOpts = [];
  vi.mocked(runCommandAsync).mockReset();
  vi.mocked(runCommandAsync).mockImplementation(async (argv: unknown, opts: unknown) => {
    const cmd = String((argv as string[]).at(-1));
    commands.push(cmd);
    const l = label(cmd);
    if (l && l !== 'promoted') events.push(l);
    if (l === 'orphanCheck') return orphan ? 'f00dfeed\n' : '';
    if (l === 'stopDb' && stopError) throw stopError;
    if (l === 'df') return freeKb;
    if (l === 'fetch') {
      fetchOpts.push(opts as Record<string, unknown>);
      if (fetchError) throw fetchError;
    }
    if (l === 'probeMarker')
      return {
        absent: 'VC_MARKER_ABSENT\n',
        present: 'VC_MARKER_PRESENT\n',
        swapped: 'VC_SWAPPED_PREV\n',
        'swapped-empty': 'VC_SWAPPED_EMPTY\n',
      }[probeState];
    if (l === 'promoted') {
      if (!events.includes('promoted')) events.push('promoted');
      return 'f\n';
    }
    return '';
  });
});

const restore = (over: Record<string, unknown> = {}) =>
  restoreCompose(
    '1.2.3.4',
    '/tmp/key',
    'proj',
    { ...BASE, assertWritable: writable, ...over } as never,
    { staleRetryDelaysMs: [] },
  );

describe('restoreCompose around the staged fetch', () => {
  it('retires the previous cluster only after promotion and the writable proof', async () => {
    await restore({
      assertWritable: async () => {
        events.push('writable');
        return 'writable';
      },
    });
    expect(events).toEqual([
      'orphanCheck',
      'stopDb',
      'fetch',
      'rmScript',
      'startDb',
      'promoted',
      'writable',
      'retirePrev',
      'rmDiscard',
      'analyze',
      'startApp',
    ]);
  });

  it('a lifted fence counts as proven', async () => {
    await restore({ assertWritable: async () => 'lifted' });
    expect(events).toContain('retirePrev');
  });

  it('an unreadable fence keeps .vc-prev and the app down, and names the whole finish', async () => {
    const err = await restore({ assertWritable: async () => 'unknown' }).catch((e) => e);
    const msg = String(err?.message);
    expect(msg).toMatch(/could not prove .* writable.*kept .*\.vc-prev/s);
    // The exact check, then the same retire the CLI runs, then what the
    // restore still owed the app before it starts.
    expect(msg).toContain('SHOW default_transaction_read_only');
    expect(msg).toMatch(/expect off/);
    const check = msg.indexOf('SHOW default_transaction_read_only');
    const retire = msg.indexOf('mkdir -p /var/lib/postgresql/data/.vc-discard');
    const remove = msg.indexOf('rm -rf /var/lib/postgresql/data/.vc-discard');
    const migrate = msg.indexOf('docker compose run --rm --no-deps app-migrate');
    const analyze = msg.indexOf('ANALYZE');
    const start = msg.indexOf('docker compose start app');
    expect(check).toBeGreaterThan(-1);
    expect(retire).toBeGreaterThan(check);
    expect(remove).toBeGreaterThan(retire);
    expect(migrate).toBeGreaterThan(remove);
    expect(analyze).toBeGreaterThan(migrate);
    expect(start).toBeGreaterThan(analyze);
    expect(msg).not.toMatch(/rm -rf \/var\/lib\/postgresql\/data\/\.vc-prev\b/);
    expect(events).not.toContain('retirePrev');
    expect(events).not.toContain('rmDiscard');
    expect(events).not.toContain('startApp');
  });

  it('a failed writable proof keeps .vc-prev and the app down', async () => {
    await expect(
      restore({
        assertWritable: async () => {
          throw new Error('the primary is write-fenced and could not be lifted');
        },
      }),
    ).rejects.toThrow(/write-fenced/);
    expect(events).not.toContain('retirePrev');
    expect(events).not.toContain('startApp');
  });

  it('runs the fetch once, even on an ssh transport error, with a timeout sized from the backup', async () => {
    fetchError = new Error('client_loop: send disconnect: Broken pipe');
    await expect(restore({ requiredBytes: 40 * 1024 ** 3 })).rejects.toThrow(/Broken pipe/);
    expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
    expect(fetchOpts[0]).toMatchObject({ timeout: (2048 + 300) * 1000 });
  });

  it('a small backup keeps the 900s fetch floor', async () => {
    await restore({ requiredBytes: 1024 });
    expect(fetchOpts[0]).toMatchObject({ timeout: 900_000 });
  });

  it('a failed fetch with no swap begun removes the run container and restarts the old database', async () => {
    fetchError = new Error('ERROR: Backup base_... does not exist');
    await expect(restore()).rejects.toThrow(
      /nothing was moved.*database from before it was started again.*does not exist/s,
    );
    expect(events).toEqual([
      'orphanCheck',
      'stopDb',
      'fetch',
      'rmScript',
      'rmRunContainer',
      'probeMarker',
      'restartOld',
    ]);
  });

  it('a failed fetch that left a swap half done keeps the db down and names the rerun', async () => {
    fetchError = new Error('timed out');
    probeState = 'present';
    await expect(restore()).rejects.toThrow(
      /interrupted mid-swap.*stays down.*\.vc-prev.*rerun:\n {2}vibecarbon restore$/s,
    );
    expect(events).toEqual([
      'orphanCheck',
      'stopDb',
      'fetch',
      'rmScript',
      'rmRunContainer',
      'probeMarker',
    ]);
  });

  it('a failed fetch after the swap finished keeps the db down: swapped but not proven', async () => {
    fetchError = new Error('timed out');
    probeState = 'swapped';
    await expect(restore({ rerun: 'vibecarbon restore prod' })).rejects.toThrow(
      /swapped in but was not proven.*stays down.*\.vc-prev.*redoes the swap:\n {2}vibecarbon restore prod$/s,
    );
    expect(events).not.toContain('restartOld');
    expect(events).not.toContain('startDb');
  });

  // P2: an empty volume (a fresh server) has no database from before, so no
  // .vc-prev: the message must not send the operator looking for one.
  it('swapped but not proven on an empty volume names no previous database', async () => {
    fetchError = new Error('timed out');
    probeState = 'swapped-empty';
    const err = await restore().catch((e) => e);
    expect(err.message).toMatch(/swapped in but was not proven/);
    expect(err.message).not.toContain('.vc-prev');
    expect(err.message).toMatch(/held no database before/);
    expect(err.message.split('\n').at(-1)).toBe('  vibecarbon restore');
  });

  // P3: the script upload and the orphan check run before anything stops, so
  // a failure there leaves the database serving.
  it('writes the script and checks for an orphan before it stops the app or db', async () => {
    const { sshRunScript } = await import('../../../src/lib/ssh.js');
    const order: string[] = [];
    vi.mocked(sshRunScript).mockImplementationOnce(async () => {
      order.push(`script@${events.length}`);
      return '';
    });
    await restore();
    expect(order).toEqual(['script@0']);
    expect(events.indexOf('orphanCheck')).toBeLessThan(events.indexOf('stopDb'));
  });

  it('a stop that fails removes the script and says the app may be down', async () => {
    stopError = new Error('Cannot connect to the Docker daemon');
    const err = await restore().catch((e) => e);
    expect(err.message).toMatch(/stopping the app and db .* failed, so nothing was restored/);
    expect(err.message.split('\n').at(-1)).toBe(
      "  ssh root@1.2.3.4 'cd /opt/proj && docker compose ps'",
    );
    expect(events).toEqual(['orphanCheck', 'stopDb', 'rmScript']);
  });

  it('an orphaned restore container from an earlier run is removed, and only it, before the fetch', async () => {
    orphan = true;
    await restore();
    expect(events.slice(0, 4)).toEqual(['orphanCheck', 'rmRunContainer', 'stopDb', 'fetch']);
    expect(commands.find((c) => c.includes('docker rm -f'))).toBe('docker rm -f proj-db-restore');
  });

  it('each run writes its own script file and removes it afterwards', async () => {
    await restore();
    const run = commands.find((c) => c.includes('bash /restore.sh')) ?? '';
    const file = run.match(/-v (\/opt\/proj\/restore-walg\.[0-9a-f]+\.sh):\/restore\.sh:ro/)?.[1];
    expect(file, run).toBeTruthy();
    expect(commands).toContain(`rm -f ${file}`);
  });

  it('refuses a backup that does not fit before anything stops', async () => {
    freeKb = String(1024 * 1024); // 1 GiB free
    await expect(restore({ requiredBytes: 10 * 1024 ** 3 })).rejects.toThrow(
      /refused before stopping anything.*11\.0 GiB free.*has 1\.0 GiB/,
    );
    expect(events).toEqual(['df']);
  });

  it('needs the writable proof to be passed in', async () => {
    await expect(restore({ assertWritable: undefined })).rejects.toThrow(
      /assertWritable is required/,
    );
    expect(events).toEqual([]);
  });
});
