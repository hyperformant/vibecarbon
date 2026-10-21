import { beforeEach, describe, expect, it, vi } from 'vitest';

// restoreCompose's order around the staged fetch (H2a, S1c):
//   - a backup too big for the volume's free space refuses before anything stops;
//   - a fetch that fails brings the untouched pre-restore database back up;
//   - the previous cluster ($PGDATA/.vc-prev) goes only after promotion AND the
//     writable proof, and before the app returns.

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

let events: string[];
let fetchFails: boolean;
let freeKb: string;

function label(cmd: string): string | null {
  if (cmd.includes('df -Pk')) return 'df';
  if (cmd.includes('docker compose stop db')) return 'stopDb';
  if (cmd.includes('bash /restore.sh')) return 'fetch';
  if (cmd.includes('docker compose start db && docker compose start app')) return 'restartOld';
  if (cmd.includes('docker compose start db')) return 'startDb';
  if (cmd.includes('pg_is_in_recovery')) return 'promoted';
  if (cmd.includes('rm -rf /var/lib/postgresql/data/.vc-prev')) return 'discardPrev';
  if (/psql\b.*\bANALYZE\b/.test(cmd)) return 'analyze';
  if (cmd.includes('docker compose start app')) return 'startApp';
  return null;
}

beforeEach(() => {
  events = [];
  fetchFails = false;
  freeKb = '';
  vi.mocked(runCommandAsync).mockReset();
  vi.mocked(runCommandAsync).mockImplementation(async (argv: unknown) => {
    const cmd = String((argv as string[]).at(-1));
    const l = label(cmd);
    if (l && l !== 'promoted') events.push(l);
    if (l === 'df') return freeKb;
    if (l === 'fetch' && fetchFails) throw new Error('ERROR: Backup base_... does not exist');
    if (l === 'promoted') {
      if (!events.includes('promoted')) events.push('promoted');
      return 'f\n';
    }
    return '';
  });
});

describe('restoreCompose around the staged fetch', () => {
  it('drops the previous cluster only after promotion and the writable proof', async () => {
    await restoreCompose(
      '1.2.3.4',
      '/tmp/key',
      'proj',
      { ...BASE, assertWritable: async () => void events.push('writable') },
      { staleRetryDelaysMs: [] },
    );
    expect(events).toEqual([
      'stopDb',
      'fetch',
      'startDb',
      'promoted',
      'writable',
      'discardPrev',
      'analyze',
      'startApp',
    ]);
  });

  it('a failed writable proof keeps .vc-prev and the app down', async () => {
    await expect(
      restoreCompose(
        '1.2.3.4',
        '/tmp/key',
        'proj',
        {
          ...BASE,
          assertWritable: async () => {
            throw new Error('the primary is write-fenced and could not be lifted');
          },
        },
        { staleRetryDelaysMs: [] },
      ),
    ).rejects.toThrow(/write-fenced/);
    expect(events).not.toContain('discardPrev');
    expect(events).not.toContain('startApp');
  });

  it('a failed fetch restarts the untouched database and says so', async () => {
    fetchFails = true;
    await expect(
      restoreCompose(
        '1.2.3.4',
        '/tmp/key',
        'proj',
        { ...BASE, assertWritable: async () => {} },
        { staleRetryDelaysMs: [] },
      ),
    ).rejects.toThrow(/database from before it was started again.*does not exist/);
    expect(events).toEqual(['stopDb', 'fetch', 'restartOld']);
  });

  it('refuses a backup that does not fit before anything stops', async () => {
    freeKb = String(1024 * 1024); // 1 GiB free
    await expect(
      restoreCompose(
        '1.2.3.4',
        '/tmp/key',
        'proj',
        { ...BASE, requiredBytes: 10 * 1024 ** 3, assertWritable: async () => {} },
        { staleRetryDelaysMs: [] },
      ),
    ).rejects.toThrow(/refused before stopping anything.*11\.0 GiB free.*has 1\.0 GiB/);
    expect(events).toEqual(['df']);
  });

  it('needs the writable proof to be passed in', async () => {
    await expect(
      restoreCompose('1.2.3.4', '/tmp/key', 'proj', BASE as never, { staleRetryDelaysMs: [] }),
    ).rejects.toThrow(/assertWritable is required/);
    expect(events).toEqual([]);
  });
});
