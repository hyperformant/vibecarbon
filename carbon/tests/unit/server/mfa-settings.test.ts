import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../_helpers/drizzle-mock';

const { selectMock, warnMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  warnMock: vi.fn(),
}));

// adminDb.select().from(appSettings).where(key = 'mfa_enabled').limit(1)
vi.mock('@server/db/client', () => ({
  adminDb: { select: () => queryChain(selectMock) },
}));

vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: warnMock, debug: vi.fn() },
}));

const { isMfaGloballyEnabled, __resetMfaSettingsCache } = await import('@server/lib/mfa-settings');

beforeEach(() => {
  __resetMfaSettingsCache();
  selectMock.mockReset();
  warnMock.mockReset();
});

describe('isMfaGloballyEnabled', () => {
  it('returns true when the setting is { enabled: true }', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: true } }]);
    expect(await isMfaGloballyEnabled()).toBe(true);
  });

  it('returns false when the setting is { enabled: false }', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isMfaGloballyEnabled()).toBe(false);
  });

  it('returns false when the row is missing', async () => {
    selectMock.mockResolvedValueOnce([]);
    expect(await isMfaGloballyEnabled()).toBe(false);
  });

  it('caches within the TTL — a second call issues no query', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: true } }]);
    expect(await isMfaGloballyEnabled()).toBe(true);
    expect(await isMfaGloballyEnabled()).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('__resetMfaSettingsCache forces a re-query', async () => {
    selectMock.mockResolvedValueOnce([{ value: { enabled: true } }]);
    expect(await isMfaGloballyEnabled()).toBe(true);
    __resetMfaSettingsCache();
    selectMock.mockResolvedValueOnce([{ value: { enabled: false } }]);
    expect(await isMfaGloballyEnabled()).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('returns null (unknown) and warns when the read throws with nothing cached', async () => {
    selectMock.mockRejectedValueOnce(new Error('db down'));
    expect(await isMfaGloballyEnabled()).toBeNull();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
