import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  isCancel: vi.fn(() => false),
}));

import * as p from '@clack/prompts';
import { runDownload, SPEC } from '../../../src/backup.js';

/**
 * `backup -action download` fetches `backups/<name>` objects — the legacy
 * `*_full.tar.gz` dumps that wal-g never writes — or, for a k8s environment
 * with no object storage at all, a dump from the backup pod. On every
 * wal-g environment (compose, and k8s with S3) it can only ever fail with
 * a filename-format error or a missing object, and the file it would
 * produce could not be restored anyway (restore is wal-g-native). Say so up
 * front and point at the command that does work.
 */
const spinner = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });
const lastError = () =>
  String((p.log.error as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? '');

describe('runDownload on a wal-g environment', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    (p.log.error as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('compose: exits 1 before touching SSH, pointing at `vibecarbon restore`', async () => {
    const downloadS3 = vi.fn();
    await expect(
      runDownload({
        s: spinner(),
        source: 'myapp_20260507.tar.gz',
        isCompose: true,
        useS3: true,
        serverIp: '1.2.3.4',
        sshKeyPath: '/tmp/key',
        deps: { downloadPod: downloadS3 },
      }),
    ).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(downloadS3).not.toHaveBeenCalled();
    expect(lastError()).toMatch(/wal-g/i);
    expect(lastError()).toMatch(/vibecarbon restore/);
  });

  it('k8s with object storage: same refusal', async () => {
    await expect(
      runDownload({
        s: spinner(),
        source: 'x.tar.gz',
        isCompose: false,
        useS3: true,
        serverIp: '1.2.3.4',
        sshKeyPath: '/tmp/key',
        deps: { downloadPod: vi.fn() },
      }),
    ).rejects.toThrow('exit');
    expect(lastError()).toMatch(/vibecarbon restore/);
  });

  it('k8s with NO object storage still downloads from the backup pod (the one path that works)', async () => {
    const downloadPod = vi.fn(async () => '/tmp/x.tar.gz');
    await runDownload({
      s: spinner(),
      source: 'x.tar.gz',
      isCompose: false,
      useS3: false,
      serverIp: '1.2.3.4',
      sshKeyPath: '/tmp/key',
      deps: { downloadPod },
    });
    expect(downloadPod).toHaveBeenCalledWith('1.2.3.4', '/tmp/key', 'x.tar.gz');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('help no longer advertises the download round-trip as the scripted example', () => {
    const examples = (SPEC as { examples: Array<{ command: string }> }).examples.map(
      (e) => e.command,
    );
    expect(examples.some((c) => c.includes('-action download'))).toBe(false);
    const sourceFlag = (SPEC as { flags: Array<{ name: string; description: string }> }).flags.find(
      (f) => f.name === 'source',
    );
    expect(sourceFlag?.description).toMatch(/legacy|pod/i);
  });
});
