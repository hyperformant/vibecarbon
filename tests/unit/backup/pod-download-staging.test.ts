import { describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  isCancel: vi.fn(() => false),
}));

const ssh = vi.hoisted(() => ({
  getPostgresPod: vi.fn(async () => 'postgres-0'),
  sshKubectl: vi.fn(async () => ''),
  scpDownload: vi.fn(async () => undefined),
  sshRun: vi.fn(async () => ''),
}));

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  ...ssh,
}));

import { runDownload } from '../../../src/backup.js';

/**
 * A k8s environment with no object storage hands its dump to the operator
 * through the host. Ubuntu 26.04 mounts /tmp as a tmpfs of half the RAM (1.9 GB
 * on a 4 GB server, real servers 2026-11-05), so a dump staged there competes
 * with the database for memory and a large one fails. /var/tmp is on disk.
 */
describe('backup download from the pod', () => {
  it('stages the dump on disk at every step, and cleans up where it staged', async () => {
    await runDownload({
      s: { start: vi.fn(), stop: vi.fn(), message: vi.fn() },
      source: 'x.tar.gz',
      isCompose: false,
      useS3: false,
      serverIp: '1.2.3.4',
      sshKeyPath: '/k',
    });
    expect(ssh.sshKubectl.mock.calls[0]?.[2]).toContain('/var/tmp/x.tar.gz');
    expect(ssh.scpDownload.mock.calls[0]?.[2]).toBe('/var/tmp/x.tar.gz');
    expect(ssh.sshRun.mock.calls.at(-1)?.[2]).toEqual(['rm', '-f', '/var/tmp/x.tar.gz']);
  });
});
