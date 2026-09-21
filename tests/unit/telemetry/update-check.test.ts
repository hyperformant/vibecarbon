import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUpdateNotice,
  printUpdateNotice,
  refreshUpdateCache,
  resetUpdateNoticeForTests,
} from '../../../src/lib/telemetry/update-check.js';

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
  it('returns a two-line notice when the cache holds a newer version: prose, then the command alone', () => {
    writeCache('0.99.0', 0);
    const notice = getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir });
    expect(notice).toContain('0.41.0');
    expect(notice).toContain('0.99.0');
    // The command is the whole second line (ANSI aside) — no separator or
    // prose can be read as part of it.
    const lines = (notice as string).split('\n');
    expect(lines).toHaveLength(2);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
    expect(lines[1].replace(/\x1b\[[0-9;]*m/g, '')).toBe('npm i -g vibecarbon');
    expect(lines[0]).not.toContain('npm');
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

  it('resolves silently on network failure and non-200, and persists attempt time', async () => {
    const fetchImpl1 = vi.fn().mockRejectedValue(new Error('offline'));
    await refreshUpdateCache({
      env: {},
      stateDir: dir,
      fetchImpl: fetchImpl1,
    });
    expect(fetchImpl1).toHaveBeenCalledTimes(1);
    const cache1 = JSON.parse(readFileSync(cachePath(), 'utf-8'));
    expect(cache1.checkedAt).toBeDefined();
    expect(cache1.latestVersion).toBeUndefined();

    const fetchImpl2 = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    await refreshUpdateCache({
      env: {},
      stateDir: dir,
      fetchImpl: fetchImpl2,
    });
    expect(fetchImpl2).not.toHaveBeenCalled(); // Should not refetch within 24h
  });

  it('preserves prior latestVersion when fetch fails', async () => {
    writeCache('0.99.0', 25 * 60 * 60 * 1000); // 25h old, stale
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await refreshUpdateCache({ env: {}, stateDir: dir, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(readFileSync(cachePath(), 'utf-8'));
    expect(cache.latestVersion).toBe('0.99.0'); // Prior version preserved
    expect(cache.checkedAt).toBeDefined(); // New timestamp
    const notice = getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir });
    expect(notice).toContain('0.99.0'); // Notice still works
  });

  it('failed attempt prevents refetch within 24h', async () => {
    const fetchImpl1 = vi.fn().mockRejectedValue(new Error('offline'));
    await refreshUpdateCache({
      env: {},
      stateDir: dir,
      fetchImpl: fetchImpl1,
    });
    expect(fetchImpl1).toHaveBeenCalledTimes(1);

    // Immediate second call should not fetch again
    const fetchImpl2 = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ latest: '0.42.0' }), { status: 200 }));
    await refreshUpdateCache({
      env: {},
      stateDir: dir,
      fetchImpl: fetchImpl2,
    });
    expect(fetchImpl2).not.toHaveBeenCalled();
  });
});

describe('getUpdateNotice colour', () => {
  it('renders the notice in yellow, not dim', () => {
    writeCache('0.99.0', 0);
    const notice = getUpdateNotice({ currentVersion: '0.41.0', stateDir: dir }) as string;
    expect(notice.startsWith('\x1b[33m')).toBe(true);
    expect(notice).not.toContain('\x1b[2m');
  });
});

describe('printUpdateNotice', () => {
  beforeEach(() => resetUpdateNoticeForTests());

  it('prints the notice followed by a blank line and returns true', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    const printed = printUpdateNotice({
      currentVersion: '0.41.0',
      stateDir: dir,
      isTTY: true,
      log,
    });
    expect(printed).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('Update available 0.41.0 → 0.99.0');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('adds a leading blank line when asked (fallback path for banner-less commands)', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    printUpdateNotice({
      currentVersion: '0.41.0',
      stateDir: dir,
      isTTY: true,
      leadingBlank: true,
      log,
    });
    const line = log.mock.calls[0][0] as string;
    expect(line.startsWith('\n')).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('prints at most once per process', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(
      true,
    );
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(
      false,
    );
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('prints nothing when stdout is not a TTY', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn();
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: false, log })).toBe(
      false,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('prints nothing when there is no newer version', () => {
    writeCache('0.41.0', 0);
    const log = vi.fn();
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(
      false,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('does not consume the once-guard when nothing was printed', () => {
    const log = vi.fn();
    printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: false, log });
    writeCache('0.99.0', 0);
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(
      true,
    );
  });

  it('never throws when the sink throws (EPIPE in a finally must not mask the real error)', () => {
    writeCache('0.99.0', 0);
    const log = vi.fn(() => {
      throw new Error('EPIPE');
    });
    expect(() =>
      printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log }),
    ).not.toThrow();
    expect(printUpdateNotice({ currentVersion: '0.41.0', stateDir: dir, isTTY: true, log })).toBe(
      false,
    );
  });
});
