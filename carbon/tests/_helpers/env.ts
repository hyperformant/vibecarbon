/**
 * Temporarily set environment variables for a test, returning a restore
 * function. Closure-based — no globals, safe to call from concurrent tests
 * as long as the variables don't overlap.
 *
 * Example:
 *   it('falls back to default SITE_URL', () => {
 *     const restore = mockEnv({ SITE_URL: undefined });
 *     try {
 *       // ... assertion that exercises the fallback path
 *     } finally {
 *       restore();
 *     }
 *   });
 */
export function mockEnv(vars: Record<string, string | undefined>): () => void {
  const original: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
