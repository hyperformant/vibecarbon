import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// C2 — provider-aware token resolution. resolveProviderToken() is the single
// replacement for nine hand-rolled per-command token idioms (see
// task-3-brief.md).
//
// A3 sweep (2026-07): resolution is now env-only — the old credentials-file
// fallback (loadCredentials()) and its `includeEnv` toggle are gone.
// process.env[TOKEN_ENV] is populated either by the operator's shell/CI or,
// for project-scoped tokens, by bootstrapOperatorEnv folding the project's
// .env.local into process.env at CLI startup (project.js) — real env always
// wins there, and this function has no fallback source left to distinguish.

const { PROVIDERS, resolveProviderToken } = await import('../../../src/lib/providers/index.js');

// One row per provider: [providerId, TOKEN_ENV] — DERIVED from the registry
// so provider N+1 is drafted into every resolution case automatically (this
// table was hand-listed until the 2026-08-07 test-architecture audit, which
// meant a new provider was simply absent here with no failure). The literal
// env-var names are pinned in tests/_shared/provider-expected.ts, not here.
const PROVIDER_ROWS: Array<[string, string]> = Object.entries(PROVIDERS).map(([id, Provider]) => [
  id,
  Provider.TOKEN_ENV,
]);

// vitest 4.1.10 bug: vi.stubEnv(name, undefined) fails to DELETE a key that an
// earlier test stubbed and vi.unstubAllEnvs() restored — the ambient value
// survives the second stub. So a HETZNER_API_TOKEN exported by the shell (any
// dev machine, or the CI e2e job where the perf-table commit hook runs this
// suite) leaked into the env-unset tests and failed them — with the real token
// in the assertion output. Scrub ambient tokens imperatively instead; tests
// that want env set opt back in with vi.stubEnv(name, value).
const ambientTokens = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [, tokenEnv] of PROVIDER_ROWS) ambientTokens.set(tokenEnv, process.env[tokenEnv]);
});
beforeEach(() => {
  for (const [, tokenEnv] of PROVIDER_ROWS) delete process.env[tokenEnv];
});
afterAll(() => {
  for (const [tokenEnv, value] of ambientTokens) {
    if (value === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = value;
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveProviderToken', () => {
  describe.each(PROVIDER_ROWS)('provider: %s', (providerId, tokenEnv) => {
    it('returns the env var value when set', () => {
      vi.stubEnv(tokenEnv, 'env-token');
      expect(resolveProviderToken(providerId)).toBe('env-token');
    });

    it('returns null when the env var is unset', () => {
      expect(resolveProviderToken(providerId)).toBeNull();
    });

    it('takes no options — a stray options object is silently ignored (no includeEnv toggle anymore)', () => {
      vi.stubEnv(tokenEnv, 'env-token');
      // @ts-expect-error — exercising a caller that hasn't migrated off the
      // retired options object; resolveProviderToken(providerId) now has a
      // single required arg. Extra JS args are simply unused.
      expect(resolveProviderToken(providerId, { includeEnv: false })).toBe('env-token');
    });
  });

  it('throws for an unknown provider id', () => {
    expect(() => resolveProviderToken('not-a-cloud')).toThrow('Unknown provider');
  });
});
