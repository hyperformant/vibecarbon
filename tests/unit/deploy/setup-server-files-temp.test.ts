/**
 * setupServerFiles (src/lib/deploy/compose/index.js) packs the bundle into a
 * tarball and streams it to the server. Both hold the rendered .env.
 *
 * Scale calls it with no pre-rendered bundle, so it renders its own (the old
 * server's .env replayed). It used to leave that bundle behind on every call,
 * plus an empty vc-deploy- dir it made and never used, and the tarball
 * whenever the pack or the upload failed. Now everything it makes is gone
 * when it returns or throws, and a bundle the caller passed in is the
 * caller's to remove (the deploy removes it after its dispatch).
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const h = vi.hoisted(() => ({
  /** What each pack saw: the bundle dir it packed and whether it held .env. */
  packs: [] as Array<{ from: string; hadEnv: boolean; tarball: string }>,
  failUpload: false,
  failPack: false,
}));

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommandAsync: vi.fn(async (argv: string[]) => {
      if (argv[0] === 'tar') {
        const tarball = argv[2];
        const from = argv[4];
        h.packs.push({ from, hadEnv: existsSync(join(from, '.env')), tarball });
        // The real tar would write it; this leaves something to remove.
        writeFileSync(tarball, 'packed');
        if (h.failPack) throw new Error('tar failed');
        return '';
      }
      if (argv[0] === 'bash' && h.failUpload) {
        const err = new Error('gzip: stdin: unexpected end of file') as Error & { status: number };
        err.status = 2;
        throw err;
      }
      return '';
    }),
  };
});

vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  progressLog: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

const { setupServerFiles } = await import('../../../src/lib/deploy/compose/index.js');

/** What the code under test left in the OS temp dir (this file's own, per global-setup). */
const leftovers = () =>
  readdirSync(tmpdir()).filter((n) => !/^vc-(scale-project|given-bundle)-/.test(n));

let project: string;
beforeEach(() => {
  h.packs = [];
  h.failUpload = false;
  h.failPack = false;
  project = createTempDir('vc-scale-project-');
  writeFileSync(join(project, '.env'), 'BETTER_AUTH_SECRET=not-a-real-secret\n');
  writeFileSync(join(project, 'docker-compose.yml'), 'services: {}\n');
  vi.spyOn(process, 'cwd').mockReturnValue(project);
});
afterEach(() => vi.restoreAllMocks());

describe('setupServerFiles with no bundle (scale)', () => {
  it('renders a bundle, uploads it, and leaves nothing behind', async () => {
    await setupServerFiles('203.0.113.7', '/never/used/key', 'scaleapp', {
      envOverrides: { BETTER_AUTH_SECRET: 'replayed' },
    });
    expect(h.packs).toHaveLength(1);
    expect(h.packs[0].hadEnv).toBe(true);
    expect(existsSync(h.packs[0].from)).toBe(false);
    expect(existsSync(h.packs[0].tarball)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ['the upload', 'failUpload'],
    ['the pack', 'failPack'],
  ] as const)('leaves nothing behind when %s fails', async (_what, flag) => {
    h[flag] = true;
    await expect(
      setupServerFiles('203.0.113.7', '/never/used/key', 'scaleapp', {}),
    ).rejects.toThrow();
    expect(h.packs).toHaveLength(1);
    expect(existsSync(h.packs[0].from)).toBe(false);
    expect(existsSync(h.packs[0].tarball)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('never changes the options it was given', async () => {
    const options = { envOverrides: {} };
    await setupServerFiles('203.0.113.7', '/never/used/key', 'scaleapp', options);
    expect(options).toEqual({ envOverrides: {} });
  });
});

describe('setupServerFiles with the deploy bundle', () => {
  it('packs the bundle it was given and leaves it for its owner; the tarball goes either way', async () => {
    const bundle = createTempDir('vc-given-bundle-');
    writeFileSync(join(bundle, '.env'), 'X=1\n');
    await setupServerFiles('203.0.113.7', '/never/used/key', 'scaleapp', { bundlePath: bundle });
    h.failUpload = true;
    await expect(
      setupServerFiles('203.0.113.7', '/never/used/key', 'scaleapp', { bundlePath: bundle }),
    ).rejects.toThrow();
    expect(h.packs.map((p) => p.from)).toEqual([bundle, bundle]);
    expect(existsSync(bundle)).toBe(true);
    for (const { tarball } of h.packs) expect(existsSync(tarball)).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});
