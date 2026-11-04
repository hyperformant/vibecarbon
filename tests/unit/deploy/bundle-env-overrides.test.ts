import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBundle } from '../../../src/lib/deploy/bundle.js';
import { formatDotenvLine, parseDotenv } from '../../../src/lib/dotenv.js';

// renderBundle runs against `process.cwd()`, so each test gets its own
// throwaway directory containing a project-shaped `.env`.
function makeProjectDir(envContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-bundle-test-'));
  writeFileSync(join(dir, '.env'), envContent);
  return dir;
}

describe('renderBundle envOverrides', () => {
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

  it('appends envOverrides keys that are missing from the local .env', () => {
    projectDir = makeProjectDir('FOO=local');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      envOverrides: {
        SMTP_PASS: 'smtp-from-old-server',
        S3_ACCESS_KEY: 'AKIA-from-old-server',
      },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      // Local key preserved
      expect(env.FOO).toBe('local');
      // Override keys appended
      expect(env.SMTP_PASS).toBe('smtp-from-old-server');
      expect(env.S3_ACCESS_KEY).toBe('AKIA-from-old-server');
      // PROJECT_NAME is set by renderBundle when projectName is given
      expect(env.PROJECT_NAME).toBe('myproj');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('lets envOverrides replace values present in the local .env', () => {
    projectDir = makeProjectDir(['SITE_URL=http://localhost:5173', 'OTHER=keep-me'].join('\n'));
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      envOverrides: {
        SITE_URL: 'https://api.from-old-server.com',
      },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.SITE_URL).toBe('https://api.from-old-server.com');
      expect(env.OTHER).toBe('keep-me');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('lets explicit options.image win over envOverrides.APP_IMAGE', () => {
    // Mirrors the scale path: we replay the old server's full env (which
    // contains the live APP_IMAGE) but also pass `options.image` so the new
    // bundle pins the same — or, when scale targets a new tag, a different —
    // image. The deploy-time override must win.
    projectDir = makeProjectDir('PROJECT_NAME=fromlocal');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      image: 'ghcr.io/owner/repo:newtag',
      envOverrides: {
        APP_IMAGE: 'ghcr.io/owner/repo:oldtag',
      },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.APP_IMAGE).toBe('ghcr.io/owner/repo:newtag');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('lets options.domain-derived overrides win over envOverrides', () => {
    // domain → DOMAIN/SITE_URL/ACME_EMAIL is set after
    // envOverrides spread, so the deploy-time domain wins. This guards
    // against scale silently re-pinning a stale domain from the old env.
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      domain: 'new-domain.example',
      envOverrides: {
        DOMAIN: 'old-domain.example',
        SITE_URL: 'https://api.old-domain.example',
      },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.DOMAIN).toBe('new-domain.example');
      expect(env.SITE_URL).toBe('https://new-domain.example');
      // Single-origin guard: nothing in the rendered env may point at an
      // api. host (and never the doubled api.api. artifact).
      for (const v of Object.values(env)) {
        expect(String(v)).not.toContain('api.new-domain.example');
        expect(String(v)).not.toContain('api.api.');
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('round-trips portable-grammar values from a captured old .env', () => {
    // Simulates the scale flow: we cat the old server's `.env`, parseDotenv
    // it into raw values, pass those as envOverrides, and renderBundle
    // re-encodes them with formatDotenvLine on write. The values we read back
    // must equal the originals.
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const oldEnvRaw: Record<string, string> = {
      DB_PASSWORD: "p@ss-with-'-quote",
      JWT_SECRET: 'eyJhbGciOi...placeholder',
      S3_SECRET_KEY: '$ymbols/and+slashes==',
    };

    const stage = renderBundle('myproj', { envOverrides: oldEnvRaw });
    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      for (const [k, v] of Object.entries(oldEnvRaw)) {
        expect(env[k]).toBe(v);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('a tlsSnapshotPrefix option writes TLS_SNAPSHOT_S3_PREFIX through formatDotenvLine', () => {
    projectDir = makeProjectDir('FOO=1');
    process.chdir(projectDir);
    const prefix = 's3://proj-backups/backups/proj/prod/tls/prod';
    const stage = renderBundle('myproj', { tlsSnapshotPrefix: prefix });
    const none = renderBundle('myproj', {});
    try {
      const text = readFileSync(join(stage, '.env'), 'utf-8');
      expect(text.split('\n')).toContain(formatDotenvLine('TLS_SNAPSHOT_S3_PREFIX', prefix));
      expect(parseDotenv(text).TLS_SNAPSHOT_S3_PREFIX).toBe(prefix);
      expect(readFileSync(join(none, '.env'), 'utf-8')).not.toContain('TLS_SNAPSHOT_S3_PREFIX');
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(none, { recursive: true, force: true });
    }
  });
});

describe('renderBundle DNS-01 challenge', () => {
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

  const DNS01_TOKEN_VARS = [
    'DO_AUTH_TOKEN',
    'CF_DNS_API_TOKEN',
    'HETZNER_API_TOKEN',
    'LINODE_TOKEN',
    'VULTR_API_KEY',
    'SCW_SECRET_KEY',
    'ACME_DNS_PROVIDER',
    'ACME_DNS_DELAY_BEFORE_CHECKS',
    'DO_PROPAGATION_TIMEOUT',
    'HETZNER_PROPAGATION_TIMEOUT',
    'VULTR_PROPAGATION_TIMEOUT',
  ];

  it('a digitalocean deploy ships no DNS token variable and no DNS-01 compose file', () => {
    projectDir = makeProjectDir('FOO=local');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      domain: 'e1.carbonstack.dev',
      dnsProvider: 'digitalocean',
      dnsToken: 'do-tok',
    });

    try {
      const reconcile = readFileSync(join(stage, 'reconcile.sh'), 'utf-8');
      expect(reconcile).not.toContain('dns01');
      // vc-compose carries the deploy's -f set: no DNS-01 override in it.
      const composeCommand = readFileSync(join(stage, 'vc-compose'), 'utf-8');
      expect(composeCommand).not.toContain('dns01');
      expect(existsSync(join(stage, 'docker-compose.dns01.prod.yml'))).toBe(false);

      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      for (const name of DNS01_TOKEN_VARS) expect(env[name]).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain('do-tok');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

describe('renderBundle tls-default.yml', () => {
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
        /* ignore */
      }
    }
  });

  it('writes tls-default.yml with explicit names for a managed-DNS (cloudflare) deploy', () => {
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      domain: 'e1.carbonstack.dev',
      dnsProvider: 'cloudflare',
      observability: true,
      n8n: true,
    });

    try {
      const tls = readFileSync(join(stage, 'volumes', 'traefik', 'tls-default.yml'), 'utf-8');
      // traefik.<domain> is main; the apex app owns its own cert; no wildcard
      expect(tls).toContain('main: "traefik.e1.carbonstack.dev"');
      expect(tls).not.toContain('main: "e1.carbonstack.dev"');
      expect(tls).toContain('grafana.e1.carbonstack.dev');
      expect(tls).toContain('n8n.e1.carbonstack.dev');
      expect(tls).not.toContain('prometheus');
      expect(tls).not.toContain('*');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('does not write tls-default.yml when domain is absent (no-domain deploy)', () => {
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {});

    try {
      // File should not exist — no domain means no cert to request.
      let exists = true;
      try {
        readFileSync(join(stage, 'volumes', 'traefik', 'tls-default.yml'), 'utf-8');
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
  it('scopes the server .env to its environment: VC_ENV, and no S3_KEY_PREFIX', () => {
    // Each environment has its own app bucket, so objects carry no key
    // prefix; VC_ENV stays because WAL-G's prefix uses it.
    projectDir = makeProjectDir('VC_ENV=prod\n');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      environment: 'staging',
      s3: {
        accessKey: 'ak',
        secretKey: 'sk',
        bucket: 'myproj-abc123-staging-storage',
        region: 'fsn1',
        endpoint: 'https://fsn1.your-objectstorage.com',
      },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env).not.toHaveProperty('S3_KEY_PREFIX');
      expect(env.VC_ENV).toBe('staging');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
