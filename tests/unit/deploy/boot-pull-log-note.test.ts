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

/**
 * M-B2a: a deploy running a db image other than the pinned one the boot pull
 * fetched (VIBECARBON_DB_IMAGE) says so, so a slow db pull is explained.
 */
describe('noteBootPull: a db image the boot pull did not fetch', () => {
  it('notes the mismatch next to the outcome', async () => {
    writeLogDetail.mockClear();
    const run = vi.fn(async () => 'ok\n');
    await noteBootPull('1.2.3.4', '/k', {
      run,
      deployDbImage: 'ghcr.io/hyperformant/postgres-dev:17.11-walg3.0.9-r3-abcdef123456',
    });
    const lines = writeLogDetail.mock.calls.map((c) => c[0]);
    expect(lines).toContain('[boot-pull] 1.2.3.4: core images already pulled at boot');
    expect(
      lines.some((l: string) =>
        /\[boot-pull\] 1\.2\.3\.4: this deploy runs db image ghcr\.io\/hyperformant\/postgres-dev:.* not the pinned .* the boot pull fetched; the deploy pull fetches it/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it('the pinned db image: no extra line', async () => {
    writeLogDetail.mockClear();
    const { dbImageRef } = await import('../../../src/lib/images.js');
    await noteBootPull('1.2.3.4', '/k', {
      run: vi.fn(async () => 'ok'),
      deployDbImage: dbImageRef(),
    });
    expect(writeLogDetail).toHaveBeenCalledTimes(1);
  });
});

describe('noteBootPull: a malformed VIBECARBON_DB_IMAGE', () => {
  it('is noted as unreadable, never an unhandled rejection or a throw', async () => {
    const prev = process.env.VIBECARBON_DB_IMAGE;
    process.env.VIBECARBON_DB_IMAGE = 'not a ref ::';
    try {
      writeLogDetail.mockClear();
      await expect(
        noteBootPull('1.2.3.4', '/k', { run: vi.fn(async () => 'ok') }),
      ).resolves.toBeUndefined();
      expect(writeLogDetail).toHaveBeenCalledWith(
        '[boot-pull] 1.2.3.4: core images already pulled at boot',
      );
    } finally {
      if (prev === undefined) delete process.env.VIBECARBON_DB_IMAGE;
      else process.env.VIBECARBON_DB_IMAGE = prev;
    }
  });
});
