import { describe, expect, it, vi } from 'vitest';
import { DB_IMAGE, DB_IMAGE_TAG, DEV_DB_IMAGE } from '../../../src/lib/images.js';
import {
  E2EDbImageError,
  ghcrManifestExists,
  selectE2EDbImage,
} from '../../e2e/utils/db-image-select.js';

const RELEASE = `${DB_IMAGE}:${DB_IMAGE_TAG}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const DEV = `${DEV_DB_IMAGE}:${DB_IMAGE_TAG}-0123456789ab`;

function deps(published: string[], dirty: string[] = []) {
  const env: Record<string, string | undefined> = {};
  const manifestExists = vi.fn(async (ref: string) => published.includes(ref));
  const git = { dirtyInputs: () => dirty, lastInputCommit: () => SHA };
  return { env, manifestExists, git, log: () => {} };
}

describe('selectE2EDbImage', () => {
  it('release present: no override', async () => {
    const d = deps([RELEASE, DEV]);
    await expect(selectE2EDbImage(d)).resolves.toEqual({ ref: RELEASE, source: 'release' });
    expect(d.env.VIBECARBON_DB_IMAGE).toBeUndefined();
    expect(d.manifestExists).toHaveBeenCalledTimes(1);
  });

  it('release missing, dev present: sets VIBECARBON_DB_IMAGE to the sha12 dev tag', async () => {
    const d = deps([DEV]);
    await expect(selectE2EDbImage(d)).resolves.toEqual({ ref: DEV, source: 'dev' });
    expect(d.env.VIBECARBON_DB_IMAGE).toBe(DEV);
  });

  it('both missing: fails fast naming the sha and what to do', async () => {
    const d = deps([]);
    const err = await selectE2EDbImage(d).catch((e) => e);
    expect(err).toBeInstanceOf(E2EDbImageError);
    expect(err.message).toMatch(
      /dev image for 0123456789ab not published yet .*push the branch and wait for publish-db-image-dev, or set VIBECARBON_DB_IMAGE/,
    );
    expect(d.env.VIBECARBON_DB_IMAGE).toBeUndefined();
  });

  it('dirty image inputs: fails before any registry lookup', async () => {
    const d = deps([RELEASE], ['docker/postgres-walg/Dockerfile']);
    await expect(selectE2EDbImage(d)).rejects.toThrow(
      /db image inputs differ from HEAD \(docker\/postgres-walg\/Dockerfile\)/,
    );
    expect(d.manifestExists).not.toHaveBeenCalled();
  });

  it('an operator-set VIBECARBON_DB_IMAGE wins, with no checks', async () => {
    const d = deps([], ['docker/wal-g/Dockerfile']);
    d.env.VIBECARBON_DB_IMAGE = 'ghcr.io/x/pg:t';
    await expect(selectE2EDbImage(d)).resolves.toEqual({
      ref: 'ghcr.io/x/pg:t',
      source: 'override',
    });
    expect(d.manifestExists).not.toHaveBeenCalled();
  });
});

describe('ghcrManifestExists', () => {
  const res = (status: number, body: unknown = {}) =>
    ({ status, ok: status < 300, json: async () => body }) as Response;

  it('200 yes, 404 no, token DENIED no; HEAD only, with the token', async () => {
    for (const [status, want] of [
      [200, true],
      [404, false],
    ] as const) {
      const f = vi.fn(async (url: string, _init?: RequestInit) =>
        url.includes('/token') ? res(200, { token: 'tk' }) : res(status),
      );
      await expect(
        ghcrManifestExists('ghcr.io/a/b:t1', f as unknown as typeof fetch),
      ).resolves.toBe(want);
      expect(f.mock.calls[1][0]).toBe('https://ghcr.io/v2/a/b/manifests/t1');
      expect(f.mock.calls[1][1]).toMatchObject({
        method: 'HEAD',
        headers: { Authorization: 'Bearer tk' },
      });
    }
    const denied = vi.fn(async () => res(403));
    await expect(
      ghcrManifestExists('ghcr.io/a/b:t1', denied as unknown as typeof fetch),
    ).resolves.toBe(false);
  });

  it('any other answer throws rather than guessing "not published"', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('/token') ? res(200, { token: 'tk' }) : res(503),
    );
    await expect(
      ghcrManifestExists('ghcr.io/a/b:t1', f as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
    await expect(
      ghcrManifestExists('docker.io/a/b:t1', f as unknown as typeof fetch),
    ).rejects.toThrow(/not a ghcr.io/);
  });
});
