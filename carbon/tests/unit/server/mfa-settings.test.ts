import { beforeEach, describe, expect, it, vi } from 'vitest';

const { maybeSingleMock, warnMock } = vi.hoisted(() => ({
  maybeSingleMock: vi.fn(),
  warnMock: vi.fn(),
}));

// supabaseAdmin.from('app_settings').select('value').eq('key','mfa_enabled').maybeSingle()
vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
  },
}));

vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: warnMock, debug: vi.fn() },
}));

const { isMfaGloballyEnabled, __resetMfaSettingsCache } = await import('@server/lib/mfa-settings');

beforeEach(() => {
  __resetMfaSettingsCache();
  maybeSingleMock.mockReset();
  warnMock.mockReset();
});

describe('isMfaGloballyEnabled', () => {
  it('returns true when the setting is { enabled: true }', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: true } }, error: null });
    expect(await isMfaGloballyEnabled()).toBe(true);
  });

  it('returns false when the setting is { enabled: false }', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: false } }, error: null });
    expect(await isMfaGloballyEnabled()).toBe(false);
  });

  it('returns false when the row is missing', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    expect(await isMfaGloballyEnabled()).toBe(false);
  });

  it('caches within the TTL — a second call issues no query', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: true } }, error: null });
    expect(await isMfaGloballyEnabled()).toBe(true);
    expect(await isMfaGloballyEnabled()).toBe(true);
    expect(maybeSingleMock).toHaveBeenCalledTimes(1);
  });

  it('__resetMfaSettingsCache forces a re-query', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: true } }, error: null });
    expect(await isMfaGloballyEnabled()).toBe(true);
    __resetMfaSettingsCache();
    maybeSingleMock.mockResolvedValueOnce({ data: { value: { enabled: false } }, error: null });
    expect(await isMfaGloballyEnabled()).toBe(false);
    expect(maybeSingleMock).toHaveBeenCalledTimes(2);
  });

  it('fails open to false (gate inert) and warns when the read throws', async () => {
    maybeSingleMock.mockRejectedValueOnce(new Error('db down'));
    expect(await isMfaGloballyEnabled()).toBe(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
