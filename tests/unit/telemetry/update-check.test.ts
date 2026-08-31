import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUpdateNotice, refreshUpdateCache } from '../../../src/lib/telemetry/update-check.js';

let dir: string;
const cachePath = () => join(dir, 'update-check.json');
const writeCache = (latestVersion: string, ageMs: number) =>
  writeFileSync(
    cachePath(),
    JSON.stringify({ latestVersion, checkedAt: new Date(Date.now() - ageMs).toISOString() }),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-update-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getUpdateNotice', () => {
  it('returns a one-line notice when the cache holds a newer version', () => {
    writeCache('0.99.0', 0);
    const notice = getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir });
    expect(notice).toContain('0.41.0');
    expect(notice).toContain('0.99.0');
    expect(notice).toContain('npm i -g vibecarbon');
  });

  it('returns null when cache is same/older version, missing, or corrupt', () => {
    expect(getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir })).toBeNull();
    writeCache('0.41.0', 0);
    expect(getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir })).toBeNull();
    writeFileSync(cachePath(), '{corrupt');
    expect(getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir })).toBeNull();
  });
});

describe('refreshUpdateCache', () => {
  const okFetch = (latest: string) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ latest }), { status: 200 }));

  it('fetches and writes the cache when stale', async () => {
    writeCache('0.41.0', 25 * 60 * 60 * 1000); // 25h old
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({ env: {}, stateDir: dir, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe('https://vibecarbon.com/api/v1/cli/version');
    expect(JSON.parse(readFileSync(cachePath(), 'utf-8')).latestVersion).toBe('0.42.0');
  });

  it('does not fetch when the cache is fresh (<24h)', async () => {
    writeCache('0.41.0', 60 * 1000);
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({ env: {}, stateDir: dir, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not fetch in CI', async () => {
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({ env: { CI: 'true' }, stateDir: dir, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('respects VIBECARBON_API_BASE', async () => {
    const fetchImpl = okFetch('0.42.0');
    await refreshUpdateCache({
      env: { VIBECARBON_API_BASE: 'http://localhost:3000' },
      stateDir: dir,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/api/v1/cli/version');
  });

  it('resolves silently on network failure and non-200', async () => {
    await expect(
      refreshUpdateCache({
        env: {},
        stateDir: dir,
        fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
      }),
    ).resolves.toBeUndefined();
    await expect(
      refreshUpdateCache({
        env: {},
        stateDir: dir,
        fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 503 })),
      }),
    ).resolves.toBeUndefined();
  });
});
