import { beforeEach, describe, expect, it, vi } from 'vitest';

const { maybeSingleMock, warnMock } = vi.hoisted(() => ({
  maybeSingleMock: vi.fn(),
  warnMock: vi.fn(),
}));

// supabaseAdmin.from('app_settings').select('value').eq('key','api_docs_enabled').maybeSingle()
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
  },
}));

vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: warnMock, debug: vi.fn() },
}));

const { isApiDocsEnabled, __resetDocsSettingsCache } = await import('@server/lib/docs-settings');

beforeEach(() => {
  __resetDocsSettingsCache();
  maybeSingleMock.mockReset();
  warnMock.mockReset();
});

describe('isApiDocsEnabled', () => {
  it('returns true when the setting is { enabled: true }', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: true } }, error: null });
    expect(await isApiDocsEnabled()).toBe(true);
  });

  it('returns false when the setting is { enabled: false }', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: false } }, error: null });
    expect(await isApiDocsEnabled()).toBe(false);
  });

  it('returns true when the row is missing (migration not yet run)', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    expect(await isApiDocsEnabled()).toBe(true);
  });

  it('treats a row without an `enabled` key as enabled, not disabled', async () => {
    // Guards against reading the flag as `value?.enabled === true`, which would
    // silently take the docs down on a malformed row instead of defaulting on.
    maybeSingleMock.mockResolvedValueOnce({ data: { value: {} }, error: null });
    expect(await isApiDocsEnabled()).toBe(true);
  });

  it('caches within the TTL — a second call issues no query', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: false } }, error: null });
    expect(await isApiDocsEnabled()).toBe(false);
    expect(await isApiDocsEnabled()).toBe(false);
    expect(maybeSingleMock).toHaveBeenCalledTimes(1);
  });

  it('__resetDocsSettingsCache forces a re-query', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: true } }, error: null });
    expect(await isApiDocsEnabled()).toBe(true);
    __resetDocsSettingsCache();
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: false } }, error: null });
    expect(await isApiDocsEnabled()).toBe(false);
    expect(maybeSingleMock).toHaveBeenCalledTimes(2);
  });

  it('fails open to true and warns when the read throws', async () => {
    maybeSingleMock.mockRejectedValueOnce(new Error('db down'));
    expect(await isApiDocsEnabled()).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('fails open to the last-known value rather than the default', async () => {
    // A disabled surface must not pop back open the moment the DB blips.
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: false } }, error: null });
    expect(await isApiDocsEnabled()).toBe(false);
    __resetDocsSettingsCache();
    // Re-seed the cache, then expire it and fail the next read.
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: false } }, error: null });
    expect(await isApiDocsEnabled()).toBe(false);
    maybeSingleMock.mockRejectedValueOnce(new Error('db down'));
    vi.setSystemTime(Date.now() + 31_000);
    expect(await isApiDocsEnabled()).toBe(false);
    vi.useRealTimers();
  });

  it('surfaces a query error as a fail-open, not a thrown rejection', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    expect(await isApiDocsEnabled()).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
