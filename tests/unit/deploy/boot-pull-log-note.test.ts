import { describe, expect, it, vi } from 'vitest';

/**
 * The deploy log notes what the boot image pull reported, without waiting on
 * it or retrying it: on a failed boot pull the deploy's own pull does the work
 * and the log says why the images were not already there.
 */
const writeLogDetail = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/deploy-logger.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  writeLogDetail,
}));

const { bootPullLogLine, noteBootPull } = await import('../../../src/lib/deploy/compose/index.js');

describe('bootPullLogLine', () => {
  it('names the outcome', () => {
    expect(bootPullLogLine('1.2.3.4', 'ok\n')).toBe(
      '[boot-pull] 1.2.3.4: core images already pulled at boot',
    );
    expect(bootPullLogLine('1.2.3.4', 'running')).toBe(
      '[boot-pull] 1.2.3.4: still pulling at boot; the deploy pull shares the work',
    );
    expect(bootPullLogLine('1.2.3.4', 'failed: 1 image(s), denied: x')).toBe(
      '[boot-pull] 1.2.3.4: failed: 1 image(s), denied: x; the deploy pull does the work',
    );
    expect(bootPullLogLine('1.2.3.4', 'absent')).toBe(
      '[boot-pull] 1.2.3.4: no boot pull on this server (booted before it existed)',
    );
  });
});

describe('noteBootPull', () => {
  it('reads the status once and writes one deploy-log line', async () => {
    const run = vi.fn(async () => 'failed: 1 image(s), denied: x\n');
    await noteBootPull('1.2.3.4', '/k', { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toContain('/var/lib/vibecarbon/boot-pull/status');
    expect(writeLogDetail).toHaveBeenCalledWith(
      '[boot-pull] 1.2.3.4: failed: 1 image(s), denied: x; the deploy pull does the work',
    );
  });

  it('a read that fails is noted, never thrown', async () => {
    const run = vi.fn(async () => {
      throw new Error('ssh: timeout');
    });
    await expect(noteBootPull('1.2.3.4', '/k', { run })).resolves.toBeUndefined();
  });
});
