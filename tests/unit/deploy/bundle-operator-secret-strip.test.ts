import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBundle } from '../../../src/lib/deploy/bundle.js';
import { parseDotenv } from '../../../src/lib/shell.js';

// Mirrors bundle-env-overrides.test.ts's fixture helper: renderBundle runs
// against process.cwd(), so each test gets its own throwaway project dir
// containing a project-shaped `.env`.
function makeProjectDir(envContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-bundle-strip-test-'));
  writeFileSync(join(dir, '.env'), envContent);
  return dir;
}

describe('renderBundle strips operator-secret keys from the raw .env baseline', () => {
  let cwdBackup: string;
  let projectDir: string;

  beforeEach(() => {
    cwdBackup = process.cwd();
  });

  afterEach(() => {
    process.chdir(cwdBackup);
    if (projectDir) {
      try {
        rmSync(projectDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  it('drops an operator-secret key that leaked into the local .env fixture', () => {
    // Simulates the pre-A4 hazard: setEnvVar used to write provider tokens
    // to both .env.local AND .env. If one is still sitting in .env (a stale
    // write, a hand edit), it must never ride the baseline echo into a bundle.
    projectDir = makeProjectDir(
      ["HETZNER_API_TOKEN='leaked-hetzner-token'", 'FOO=local'].join('\n'),
    );
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {});

    try {
      const raw = readFileSync(join(stage, '.env'), 'utf-8');
      expect(raw).not.toContain('leaked-hetzner-token');
      const env = parseDotenv(raw);
      expect(env.HETZNER_API_TOKEN).toBeUndefined();
      // Non-secret local keys are unaffected.
      expect(env.FOO).toBe('local');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('drops every operator-secret key class from the .env fixture', () => {
    projectDir = makeProjectDir(
      [
        "HETZNER_API_TOKEN='a'",
        "HETZNER_ACCESS_KEY='b'",
        "HETZNER_SECRET_KEY='c'",
        "DIGITALOCEAN_API_TOKEN='d'",
        "DIGITALOCEAN_ACCESS_KEY='e'",
        "DIGITALOCEAN_SECRET_KEY='f'",
        "CLOUDFLARE_API_TOKEN='g'",
        "STRIPE_SECRET_KEY='keep-me'",
      ].join('\n'),
    );
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {});

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.HETZNER_API_TOKEN).toBeUndefined();
      expect(env.HETZNER_ACCESS_KEY).toBeUndefined();
      expect(env.HETZNER_SECRET_KEY).toBeUndefined();
      expect(env.DIGITALOCEAN_API_TOKEN).toBeUndefined();
      expect(env.DIGITALOCEAN_ACCESS_KEY).toBeUndefined();
      expect(env.DIGITALOCEAN_SECRET_KEY).toBeUndefined();
      expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
      // A feature secret (not operator-secret classed) is untouched.
      expect(env.STRIPE_SECRET_KEY).toBe('keep-me');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('an explicit S3 override wins over a stale S3_ACCESS_KEY in the raw .env baseline', () => {
    // options.s3 is the deliberate, feature-specific propagation path
    // (Supabase storage/backup on the deployed server). S3_ACCESS_KEY here is
    // the PROVIDER-AGNOSTIC server-side namespace (renderBundle writes it from
    // the resolved s3Config for every provider; carbon/docker-compose.yml maps
    // it to AWS_ACCESS_KEY_ID for wal-g) — NOT an operator-secret, so it is not
    // stripped from the baseline. The freshly-passed value still lands because
    // the explicit override wins over any stale baseline value by merge
    // precedence. (The operator credential is HETZNER_ACCESS_KEY, covered by
    // the strip test above.)
    projectDir = makeProjectDir("S3_ACCESS_KEY='stale-leaked-key'\nFOO=local");
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      s3: { accessKey: 'fresh-key', secretKey: 'fresh-secret', region: 'us-east-1' },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.S3_ACCESS_KEY).toBe('fresh-key');
      expect(env.S3_SECRET_KEY).toBe('fresh-secret');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it("scale's old-server envOverrides replay is NOT stripped — only the raw .env baseline is", () => {
    // Documents the deliberate asymmetry: scale.js replays the old server's
    // full `.env` (which legitimately contains the server-side S3_ACCESS_KEY/
    // S3_SECRET_KEY for the storage/backup feature) via options.envOverrides.
    // That mechanism is explicit function-argument propagation, not a blind
    // file echo, and is already covered by bundle-env-overrides.test.ts's
    // round-trip test — this test pins that the server-side S3 credential keys
    // specifically survive that path, so a future "just strip everywhere" edit
    // doesn't silently break S3 credential replay on scale.
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      envOverrides: {
        S3_ACCESS_KEY: 'from-old-server',
        S3_SECRET_KEY: 'from-old-server-secret',
      },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.S3_ACCESS_KEY).toBe('from-old-server');
      expect(env.S3_SECRET_KEY).toBe('from-old-server-secret');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
