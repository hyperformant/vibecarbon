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

/**
 * Turn the S3 settings on or off in a test's mocked `env` object (the one a
 * `vi.mock('@server/lib/env', ...)` factory hands the server). On, they name
 * a placeholder endpoint and bucket; off, every one is unset.
 */
export function setFakeS3(env: Record<string, unknown>, on: boolean): void {
  env.S3_ENDPOINT = on ? 'https://s3.example.test' : undefined;
  env.S3_REGION = on ? 'eu-central' : undefined;
  env.S3_BUCKET = on ? 'bucket' : undefined;
  env.S3_ACCESS_KEY = on ? 'AKIATEST' : undefined;
  env.S3_SECRET_KEY = on ? 'secret' : undefined;
}
