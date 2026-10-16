import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../_helpers/drizzle-mock';

const { selectMock, warnMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  warnMock: vi.fn(),
}));

// adminDb.select().from(appSettings).where(key = 'api_docs_enabled').limit(1)
vi.mock('@server/db/client', () => ({
  adminDb: { select: () => queryChain(selectMock) },
}));

vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: warnMock, debug: vi.fn() },
}));

const { isApiDocsEnabled, __resetDocsSettingsCache } = await import('@server/lib/docs-settings');

beforeEach(() => {
  __resetDocsSettingsCache();
  selectMock.mockReset();
  warnMock.mockReset();
});

describe('isApiDocsEnabled', () => {
  it('returns true when the setting is { enabled: true }', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: true } }]);
    expect(await isApiDocsEnabled()).toBe(true);
  });

  it('returns false when the setting is { enabled: false }', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isApiDocsEnabled()).toBe(false);
  });

  it('returns true when the row is missing (migration not yet run)', async () => {
    selectMock.mockResolvedValueOnce([]);
    expect(await isApiDocsEnabled()).toBe(true);
  });

  it('treats a row without an `enabled` key as enabled, not disabled', async () => {
    // Guards against reading the flag as `value?.enabled === true`, which would
    // silently take the docs down on a malformed row instead of defaulting on.
    selectMock.mockResolvedValueOnce([{ value: {} }]);
    expect(await isApiDocsEnabled()).toBe(true);
  });

  it('caches within the TTL — a second call issues no query', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isApiDocsEnabled()).toBe(false);
    expect(await isApiDocsEnabled()).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('__resetDocsSettingsCache forces a re-query', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: true } }]);
    expect(await isApiDocsEnabled()).toBe(true);
    __resetDocsSettingsCache();
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isApiDocsEnabled()).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('fails open to true and warns when the read throws', async () => {
    selectMock.mockRejectedValueOnce(new Error('db down'));
    expect(await isApiDocsEnabled()).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('fails open to the last-known value rather than the default', async () => {
    // A disabled surface must not pop back open the moment the DB blips.
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isApiDocsEnabled()).toBe(false);
    __resetDocsSettingsCache();
    // Re-seed the cache, then expire it and fail the next read.
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isApiDocsEnabled()).toBe(false);
    selectMock.mockRejectedValueOnce(new Error('db down'));
    vi.setSystemTime(Date.now() + 31_000);
    expect(await isApiDocsEnabled()).toBe(false);
    vi.useRealTimers();
  });

  it('surfaces a query error as a fail-open, not a thrown rejection', async () => {
    selectMock.mockRejectedValueOnce(new Error('permission denied'));
    expect(await isApiDocsEnabled()).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
