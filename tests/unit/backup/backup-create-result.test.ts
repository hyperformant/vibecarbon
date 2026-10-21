/**
 * `vibecarbon backup <env> -action create` reports what the backup did.
 *
 * It prints the pushed base backup's name, exits 1 on a skip (a "backup" that
 * took nothing is not a success), and exits 1 when retention failed after a
 * push, naming the base that WAS pushed. The legacy offer to download a
 * `*_full.tar.gz` from `backups/` is gone: wal-g environments have no such
 * file, so it always ended in "No backups found in S3".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  logs: [] as Array<[string, string]>,
  confirm: vi.fn(async () => true),
}));

vi.mock('@clack/prompts', async (orig) => {
  const actual = await orig<typeof import('@clack/prompts')>();
  const push = (k: string) => (m: string) => h.logs.push([k, m]);
  return {
    ...actual,
    confirm: h.confirm,
    isCancel: () => false,
    log: {
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      success: push('success'),
      message: push('message'),
      step: push('step'),
    },
  };
});

const { runCreate } = await import('../../../src/backup.js');

const spinner = () => ({
  start: (m: string) => h.logs.push(['start', m]),
  stop: (m: string) => h.logs.push(['stop', m]),
  message() {},
});

class Exit extends Error {}

const base = (isCompose: boolean, deps: Record<string, unknown>) => ({
  s: spinner(),
  isCompose,
  s3Config: { bucket: 'bkt' },
  serverIp: '10.0.0.5',
  sshKeyPath: '/k',
  projectName: 'app',
  envName: 'prod',
  backupRetain: 3,
  yes: false,
  deps,
});

afterEach(() => {
  h.logs.length = 0;
  h.confirm.mockClear();
  vi.restoreAllMocks();
});

const all = () => h.logs.map(([, m]) => m).join('\n');

describe('backup create', () => {
  it.each([
    [true, 'backupCompose'],
    [false, 'triggerJob'],
  ])('compose=%s prints the pushed name and offers no download', async (isCompose, fn) => {
    const call = vi.fn(async () => ({ result: 'pushed', name: 'base_000000010000000000000004' }));
    await runCreate(base(isCompose, { [fn]: call }));
    expect(call).toHaveBeenCalled();
    expect(all()).toContain('base backup pushed: base_000000010000000000000004');
    expect(all()).not.toMatch(/No backups found in S3/);
    // The one confirm is "Create a database backup ...?": no download offer.
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(String(h.confirm.mock.calls[0][0].message)).toMatch(/Create a database backup/);
  });

  it('a skip exits 1 with the reason', async () => {
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Exit();
    });
    const call = vi.fn(async () => ({ result: 'skipped', reason: 'in-recovery' }));
    await expect(runCreate(base(false, { triggerJob: call }))).rejects.toThrow(Exit);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(all()).toMatch(/backup skipped \(in-recovery\)/);
    expect(all()).not.toMatch(/base backup pushed/);
  });

  it('a retention failure after the push exits 1 and names the base that was pushed', async () => {
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Exit();
    });
    const call = vi.fn(async () => ({
      result: 'pushed',
      name: 'base_x',
      retentionError: 'retention failed after pushing base_x: AccessDenied',
    }));
    await expect(runCreate(base(true, { backupCompose: call }))).rejects.toThrow(Exit);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(all()).toContain('base backup pushed: base_x');
    const err = h.logs.find(([k]) => k === 'error')?.[1] ?? '';
    expect(err).toMatch(/base_x was pushed/);
    expect(err).toContain('AccessDenied');
  });

  it('the legacy tar.gz helpers are gone from the command', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/backup.js', import.meta.url)),
      'utf-8',
    );
    expect(src).not.toMatch(/listS3Backups|downloadS3Backup|No backups found in S3/);
  });
});

describe('backup create while a compose scale cutover is journaled', () => {
  it('refuses before any prompt or push: the old server is fenced, not yet demoted', async () => {
    const backupCompose = vi.fn();
    h.confirm.mockClear();
    await expect(
      runCreate({
        ...base(true, { backupCompose }),
        envConfig: {
          ha: {
            writeFence: {
              ip: '10.0.0.5',
              source: 'scale',
              cutover: { oldIp: '10.0.0.5', newIp: '10.0.0.9' },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'Refusing to back up "prod": a compose scale stopped mid-cutover (old server 10.0.0.5, new server 10.0.0.9); rerun vibecarbon scale prod',
    );
    expect(backupCompose).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
