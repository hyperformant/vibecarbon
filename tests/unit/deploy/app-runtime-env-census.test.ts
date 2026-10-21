/**
 * The app gets only its own runtime keys (security plan 2026-10-20, Task 1,
 * ruling R1). One allowlist, APP_RUNTIME_KEYS, decides what reaches the app
 * on compose (the bundle's `app.env`) and on k8s (Secret
 * `vibecarbon-app-secrets`). Everything else the server holds (cloud and DNS
 * tokens, the db superuser, replication and add-on role passwords) stays in
 * the compose `.env` substitution source or Secret `vibecarbon-infra-secrets`,
 * which only the db, redis and add-on pods read, key by key.
 *
 * Two directions, each a census:
 *   (a) delivered: every key the app reads is in the allowlist or the explicit
 *       extras, so a key added to the app's env schema later still arrives;
 *   (b) withheld: no cloud, DNS or infra credential is ever in the allowlist.
 *
 * Every value here is a SENTINEL_<NAME> stand-in, never a real secret.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { featureConfigKeys, featureSecretKeys } from '../../../src/lib/config-registry.js';
import {
  APP_RUNTIME_EXTRA_KEYS,
  APP_RUNTIME_KEYS,
  appStorageCredential,
  buildAppRuntimeEnv,
} from '../../../src/lib/deploy/app-runtime-env.js';
import { renderBundle } from '../../../src/lib/deploy/bundle.js';
import {
  buildAppSecretData,
  buildInfraSecretData,
  INFRA_SECRET_KEYS,
} from '../../../src/lib/deploy/k8s/k3s.js';
import { DNS_PROVIDERS, DNS01_PROVIDERS } from '../../../src/lib/dns-provider.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

/** Keys of the zod object in carbon/src/server/lib/env.ts, read from the source. */
function envSchemaKeys(): string[] {
  const src = read('carbon/src/server/lib/env.ts');
  const start = src.indexOf('const envSchema = z.object({');
  const end = src.indexOf('\n});', start);
  expect(start, 'envSchema not found in env.ts').toBeGreaterThan(-1);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
}

/**
 * Set by the compose `environment:` block and the k8s Deployment `env:` /
 * Dockerfile, not by the allowlist: the server's own process settings, the
 * dev-only port knobs, and the DB_* connection the deploy wires explicitly.
 */
const SET_EXPLICITLY = (key: string) =>
  key.startsWith('DEV_') || key.startsWith('DB_') || key === 'NODE_ENV' || key === 'PORT';

/** Every cloud and DNS credential env var name the CLI knows about. */
function credentialEnvNames(): string[] {
  const names = new Set<string>();
  for (const row of Object.values(DNS01_PROVIDERS)) names.add(row.tokenEnvVar);
  for (const row of Object.values(DNS_PROVIDERS)) names.add(row.tokenEnv);
  for (const Provider of Object.values(PROVIDERS)) {
    if (Provider.TOKEN_ENV) names.add(Provider.TOKEN_ENV);
    if (Provider.CLI_TOKEN_ENV) names.add(Provider.CLI_TOKEN_ENV);
  }
  return [...names];
}

const INFRA_ONLY = [
  'REPL_PASSWORD',
  'METABASE_DB_PASSWORD',
  'N8N_DB_PASSWORD',
  'N8N_ENCRYPTION_KEY',
  'POSTGRES_PASSWORD',
];

describe('census (a): every key the app reads is delivered', () => {
  const allowed = new Set([...APP_RUNTIME_KEYS, ...APP_RUNTIME_EXTRA_KEYS]);

  it('reads a non-trivial schema', () => {
    const keys = envSchemaKeys();
    expect(keys).toContain('BETTER_AUTH_SECRET');
    expect(keys).toContain('STRIPE_SECRET_KEY');
    expect(keys.length).toBeGreaterThan(40);
  });

  it('every env.ts schema key is in APP_RUNTIME_KEYS or the explicit extras', () => {
    const missing = envSchemaKeys().filter((k) => !SET_EXPLICITLY(k) && !allowed.has(k));
    expect(missing, 'app env schema keys the app would never receive').toEqual([]);
  });

  it('every process.env read in the app server is delivered, set explicitly, or platform-set', () => {
    // Read outside the zod schema (CORS_ORIGINS, PROJECT_NAME, the add-on
    // flags, the Plausible pair the CSP derives from). Platform-set: k8s
    // injects KUBERNETES_*, the compose `environment:` block sets
    // DOCKER_API_PROXY, and DOCKER is the image's own marker.
    const platform = new Set(['DOCKER', 'DOCKER_API_PROXY']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, n);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) files.push(rel);
      }
    };
    walk('carbon/src/server');
    const read_ = new Set<string>();
    for (const f of files) {
      for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read_.add(m[1]);
    }
    expect(read_.size).toBeGreaterThan(5);
    const missing = [...read_].filter(
      (k) =>
        !SET_EXPLICITLY(k) && !k.startsWith('KUBERNETES_') && !platform.has(k) && !allowed.has(k),
    );
    expect(missing, 'process.env keys the app reads but never receives').toEqual([]);
  });

  it('includes every configure-managed runtime key (secret and non-secret)', () => {
    for (const key of [...featureSecretKeys(), ...featureConfigKeys()]) {
      expect(APP_RUNTIME_KEYS, key).toContain(key);
    }
  });
});

describe('census (b): no cloud, DNS or infra credential is an app runtime key', () => {
  it('sees the credential names it guards', () => {
    const names = credentialEnvNames();
    for (const n of ['HETZNER_API_TOKEN', 'CF_DNS_API_TOKEN', 'DO_AUTH_TOKEN', 'SCW_SECRET_KEY']) {
      expect(names).toContain(n);
    }
  });

  it('holds no DNS01 token, provider TOKEN_ENV or CLI_TOKEN_ENV', () => {
    const leaked = credentialEnvNames().filter((k) => APP_RUNTIME_KEYS.includes(k));
    expect(leaked).toEqual([]);
  });

  it('holds no infra-only password', () => {
    const leaked = INFRA_ONLY.filter((k) => APP_RUNTIME_KEYS.includes(k));
    expect(leaked).toEqual([]);
  });

  it('the extras carry only the app storage keys and REDIS_URL', () => {
    expect([...APP_RUNTIME_EXTRA_KEYS].sort()).toEqual(
      [
        'REDIS_URL',
        'S3_ACCESS_KEY',
        'S3_BUCKET',
        'S3_ENDPOINT',
        'S3_REGION',
        'S3_SECRET_KEY',
      ].sort(),
    );
  });
});

describe('buildAppRuntimeEnv', () => {
  it('keeps only allowlisted keys plus the extras, and drops empty values', () => {
    const out = buildAppRuntimeEnv(
      {
        BETTER_AUTH_SECRET: 'SENTINEL_BETTER_AUTH_SECRET',
        STRIPE_SECRET_KEY: 'SENTINEL_STRIPE_SECRET_KEY',
        SMTP_HOST: '',
        HETZNER_API_TOKEN: 'SENTINEL_HETZNER_API_TOKEN',
        POSTGRES_PASSWORD: 'SENTINEL_POSTGRES_PASSWORD',
        VC_ENV: 'prod',
        S3_ACCESS_KEY: 'SENTINEL_INFRA_S3_ACCESS_KEY',
      },
      { S3_ACCESS_KEY: 'SENTINEL_APP_S3_ACCESS_KEY' },
    );
    expect(out).toEqual({
      BETTER_AUTH_SECRET: 'SENTINEL_BETTER_AUTH_SECRET',
      STRIPE_SECRET_KEY: 'SENTINEL_STRIPE_SECRET_KEY',
      S3_ACCESS_KEY: 'SENTINEL_APP_S3_ACCESS_KEY',
    });
  });

  it('refuses an extra that is not an app runtime extra', () => {
    expect(() => buildAppRuntimeEnv({}, { HETZNER_API_TOKEN: 'SENTINEL_X' })).toThrow(
      /HETZNER_API_TOKEN/,
    );
  });
});

describe('appStorageCredential (the one app-S3 hand-off point)', () => {
  const s3Config = {
    accessKey: 'SENTINEL_S3_ACCESS_KEY',
    secretKey: 'SENTINEL_S3_SECRET_KEY',
    bucket: 'myapp-abc123-storage',
    endpoint: 'https://fsn1.your-objectstorage.com',
    region: 'fsn1',
  };

  it('maps an s3Config to the app S3_* keys', () => {
    expect(appStorageCredential({ s3Config })).toEqual({
      S3_ACCESS_KEY: 'SENTINEL_S3_ACCESS_KEY',
      S3_SECRET_KEY: 'SENTINEL_S3_SECRET_KEY',
      S3_BUCKET: 'myapp-abc123-storage',
      S3_ENDPOINT: 'https://fsn1.your-objectstorage.com',
      S3_REGION: 'fsn1',
    });
  });

  it('without an s3Config, carries forward what the app had before', () => {
    expect(
      appStorageCredential({
        previousAppEnv: { S3_ACCESS_KEY: 'SENTINEL_OLD', S3_BUCKET: 'b', STRIPE_SECRET_KEY: 'x' },
      }),
    ).toEqual({ S3_ACCESS_KEY: 'SENTINEL_OLD', S3_BUCKET: 'b' });
    expect(appStorageCredential({})).toEqual({});
  });
});

describe('k8s: the app Secret and the infra Secret', () => {
  const everyInfraKey: Record<string, string> = Object.fromEntries(
    [...INFRA_SECRET_KEYS, ...INFRA_ONLY, ...credentialEnvNames(), 'REDIS_PASSWORD'].map((k) => [
      k,
      `SENTINEL_${k}`,
    ]),
  );
  const envLocal = {
    ...everyInfraKey,
    BETTER_AUTH_SECRET: 'SENTINEL_BETTER_AUTH_SECRET',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'SENTINEL_ADMIN_PASSWORD',
    STRIPE_SECRET_KEY: 'SENTINEL_STRIPE_SECRET_KEY',
    REDIS_ENABLED: 'true',
  };
  const s3Config = {
    accessKey: 'SENTINEL_S3_ACCESS_KEY',
    secretKey: 'SENTINEL_S3_SECRET_KEY',
    bucket: 'myapp-abc123-storage',
    endpoint: 'https://fsn1.your-objectstorage.com',
    region: 'fsn1',
  };

  it('buildAppSecretData carries none of the infra or credential keys', () => {
    const app = buildAppSecretData({ envLocal, s3Config });
    const leaked = Object.keys(everyInfraKey).filter((k) => k in app);
    expect(leaked).toEqual([]);
    // The app's REDIS_URL embeds the redis password: that is its connection.
    expect(Object.values(app).join('\n')).not.toMatch(
      /SENTINEL_(?!BETTER_AUTH|ADMIN_PASSWORD|STRIPE|S3_|REDIS_PASSWORD@)/,
    );
    expect(app).not.toHaveProperty('S3_CREDENTIALS_INI');
  });

  it('buildAppSecretData carries the app keys, its S3 pair and REDIS_URL', () => {
    const app = buildAppSecretData({ envLocal, s3Config });
    expect(app.BETTER_AUTH_SECRET).toBe('SENTINEL_BETTER_AUTH_SECRET');
    expect(app.ADMIN_PASSWORD).toBe('SENTINEL_ADMIN_PASSWORD');
    expect(app.STRIPE_SECRET_KEY).toBe('SENTINEL_STRIPE_SECRET_KEY');
    expect(app.S3_ACCESS_KEY).toBe('SENTINEL_S3_ACCESS_KEY');
    expect(app.S3_BUCKET).toBe('myapp-abc123-storage');
    expect(app.REDIS_URL).toBe('redis://:SENTINEL_REDIS_PASSWORD@redis:6379');
  });

  it('buildInfraSecretData carries DB_PASSWORD and REPL_PASSWORD, and no app key', () => {
    const infra = buildInfraSecretData({ envLocal, s3Config, backupBucketName: 'myapp-backups' });
    expect(infra.DB_PASSWORD).toBe('SENTINEL_DB_PASSWORD');
    expect(infra.REPL_PASSWORD).toBe('SENTINEL_REPL_PASSWORD');
    expect(infra.METABASE_DB_PASSWORD).toBe('SENTINEL_METABASE_DB_PASSWORD');
    expect(infra.N8N_DB_PASSWORD).toBe('SENTINEL_N8N_DB_PASSWORD');
    expect(infra.N8N_ENCRYPTION_KEY).toBe('SENTINEL_N8N_ENCRYPTION_KEY');
    expect(infra.REDIS_PASSWORD).toBe('SENTINEL_REDIS_PASSWORD');
    expect(infra.S3_CREDENTIALS_INI).toContain('aws_access_key_id=SENTINEL_S3_ACCESS_KEY');
    for (const k of ['BETTER_AUTH_SECRET', 'ADMIN_PASSWORD', 'STRIPE_SECRET_KEY', 'REDIS_URL']) {
      expect(infra, k).not.toHaveProperty(k);
    }
    // Neither Secret ever carries a cloud or DNS token.
    for (const k of credentialEnvNames()) expect(infra, k).not.toHaveProperty(k);
  });
});

describe('compose bundle: app.env', () => {
  let cwdBackup: string;
  let projectDir: string;
  let stage: string | undefined;

  beforeEach(() => {
    cwdBackup = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'vc-app-env-'));
    writeFileSync(
      join(projectDir, '.env'),
      [
        'BETTER_AUTH_SECRET=SENTINEL_BETTER_AUTH_SECRET',
        'POSTGRES_PASSWORD=SENTINEL_POSTGRES_PASSWORD',
        'STRIPE_SECRET_KEY=SENTINEL_STRIPE_SECRET_KEY',
        'N8N_DB_PASSWORD=SENTINEL_N8N_DB_PASSWORD',
        'N8N_ENCRYPTION_KEY=SENTINEL_N8N_ENCRYPTION_KEY',
        '',
      ].join('\n'),
    );
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(cwdBackup);
    rmSync(projectDir, { recursive: true, force: true });
    if (stage) rmSync(stage, { recursive: true, force: true });
    stage = undefined;
  });

  const s3 = {
    accessKey: 'SENTINEL_S3_ACCESS_KEY',
    secretKey: 'SENTINEL_S3_SECRET_KEY',
    bucket: 'myapp-abc123-storage',
    endpoint: 'https://fsn1.your-objectstorage.com',
    region: 'fsn1',
  };

  it('holds BETTER_AUTH_SECRET and the app S3 pair, and never HETZNER_API_TOKEN', () => {
    stage = renderBundle('myproj', {
      domain: 'example.com',
      environment: 'prod',
      s3,
      dnsChallenge: true,
      dnsProvider: 'hetzner',
      dnsToken: 'SENTINEL_HETZNER_API_TOKEN',
    });
    const serverEnv = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
    // The substitution source still has the token (Traefik's DNS-01 reads it).
    expect(serverEnv.HETZNER_API_TOKEN).toBe('SENTINEL_HETZNER_API_TOKEN');
    const appEnvText = readFileSync(join(stage, 'app.env'), 'utf-8');
    const appEnv = parseDotenv(appEnvText);
    expect(appEnv.BETTER_AUTH_SECRET).toBe('SENTINEL_BETTER_AUTH_SECRET');
    expect(appEnv.STRIPE_SECRET_KEY).toBe('SENTINEL_STRIPE_SECRET_KEY');
    expect(appEnv.SITE_URL).toBe('https://example.com');
    expect(appEnv.S3_ACCESS_KEY).toBe('SENTINEL_S3_ACCESS_KEY');
    expect(appEnv.S3_BUCKET).toBe('myapp-abc123-storage');
    for (const k of [
      'HETZNER_API_TOKEN',
      'POSTGRES_PASSWORD',
      'N8N_DB_PASSWORD',
      'N8N_ENCRYPTION_KEY',
      'VC_ENV',
    ]) {
      expect(appEnv, k).not.toHaveProperty(k);
    }
    expect(appEnvText).not.toContain('SENTINEL_HETZNER_API_TOKEN');
  });

  it('a scale replay carries the old app.env storage pair forward', () => {
    stage = renderBundle('myproj', {
      envOverrides: { S3_ACCESS_KEY: 'SENTINEL_INFRA_PAIR' },
      appEnvReplay: { S3_ACCESS_KEY: 'SENTINEL_OLD_APP_PAIR', S3_BUCKET: 'old-bucket' },
    });
    const appEnv = parseDotenv(readFileSync(join(stage, 'app.env'), 'utf-8'));
    expect(appEnv.S3_ACCESS_KEY).toBe('SENTINEL_OLD_APP_PAIR');
    expect(appEnv.S3_BUCKET).toBe('old-bucket');
  });

  it('a replay from a server without app.env keeps the pair its app had', () => {
    stage = renderBundle('myproj', {
      envOverrides: { S3_ACCESS_KEY: 'SENTINEL_PREVIOUS_PAIR' },
    });
    const appEnv = parseDotenv(readFileSync(join(stage, 'app.env'), 'utf-8'));
    expect(appEnv.S3_ACCESS_KEY).toBe('SENTINEL_PREVIOUS_PAIR');
  });
});
