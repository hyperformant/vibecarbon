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
  target: 'latest',
  recoveryConf: '-restore_command\nrestore_command = \'wal-g wal-fetch "%f" "%p"\'',
};
const writable = async () => 'writable' as const;

let events: string[];
let fetchError: Error | null;
let freeKb: string;
let markerLeft: boolean;
let fetchOpts: Array<Record<string, unknown>>;

function label(cmd: string): string | null {
  if (cmd.includes('df -Pk')) return 'df';
  if (cmd.includes('docker compose stop db')) return 'stopDb';
  if (cmd.includes('bash /restore.sh')) return 'fetch';
  if (cmd.includes('docker rm -f proj-db-restore')) return 'rmRunContainer';
  if (cmd.includes('.vc-restore-in-progress')) return 'probeMarker';
  if (cmd.includes('docker compose start db && docker compose start app')) return 'restartOld';
  if (cmd.includes('docker compose start db')) return 'startDb';
  if (cmd.includes('pg_is_in_recovery')) return 'promoted';
  if (cmd.includes('mv /var/lib/postgresql/data/.vc-prev /var/lib/postgresql/data/.vc-discard'))
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
  markerLeft = false;
  fetchOpts = [];
  vi.mocked(runCommandAsync).mockReset();
  vi.mocked(runCommandAsync).mockImplementation(async (argv: unknown, opts: unknown) => {
    const cmd = String((argv as string[]).at(-1));
    const l = label(cmd);
    if (l && l !== 'promoted') events.push(l);
    if (l === 'df') return freeKb;
    if (l === 'fetch') {
      fetchOpts.push(opts as Record<string, unknown>);
      if (fetchError) throw fetchError;
    }
    if (l === 'probeMarker') return markerLeft ? 'VC_MARKER_PRESENT\n' : 'VC_MARKER_ABSENT\n';
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
      'stopDb',
      'fetch',
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

  it('an unreadable fence keeps .vc-prev and the app down, and names the cleanup', async () => {
    await expect(restore({ assertWritable: async () => 'unknown' })).rejects.toThrow(
      /could not prove .* writable.*kept .*\.vc-prev.*rm -rf \/var\/lib\/postgresql\/data\/\.vc-prev/s,
    );
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
    expect(events).toEqual(['stopDb', 'fetch', 'rmRunContainer', 'probeMarker', 'restartOld']);
  });

  it('a failed fetch that left a swap half done keeps the db down and names the rerun', async () => {
    fetchError = new Error('timed out');
    markerLeft = true;
    await expect(restore()).rejects.toThrow(
      /interrupted mid-swap.*stays down.*\.vc-prev.*rerun vibecarbon restore/s,
    );
    expect(events).toEqual(['stopDb', 'fetch', 'rmRunContainer', 'probeMarker']);
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
