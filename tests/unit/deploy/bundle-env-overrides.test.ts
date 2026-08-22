import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBundle } from '../../../src/lib/deploy/bundle.js';
import { parseDotenv } from '../../../src/lib/shell.js';

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
        SUPABASE_SERVICE_ROLE_KEY: 'srk-from-old-server',
        S3_ACCESS_KEY: 'AKIA-from-old-server',
      },
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      // Local key preserved
      expect(env.FOO).toBe('local');
      // Override keys appended
      expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe('srk-from-old-server');
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
    // domain → DOMAIN/SITE_URL/SUPABASE_URL/ACME_EMAIL is set after
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

  it('round-trips escapeDotenv-quoted values from a captured old .env', () => {
    // Simulates the scale flow: we cat the old server's `.env` (which is
    // escapeDotenv-encoded), parseDotenv it into raw values, pass those as
    // envOverrides, and renderBundle re-escapes them on write. The values
    // we read back must equal the originals.
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

  it('adds the DNS-01 override to reconcile.sh + cloudflare token to .env', () => {
    projectDir = makeProjectDir('FOO=local');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      dnsChallenge: true,
      dnsProvider: 'cloudflare',
      dnsToken: 'cf-tok',
    });

    try {
      const reconcile = readFileSync(join(stage, 'reconcile.sh'), 'utf-8');
      expect(reconcile).toContain('-f docker-compose.dns01.prod.yml');
      // Override must come after prod.yml so it replaces the Traefik command.
      expect(reconcile.indexOf('docker-compose.dns01.prod.yml')).toBeGreaterThan(
        reconcile.indexOf('docker-compose.prod.yml'),
      );

      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.ACME_DNS_PROVIDER).toBe('cloudflare');
      expect(env.CF_DNS_API_TOKEN).toBe('cf-tok');
      // No other provider's token var is written at all — the deploy carries
      // exactly one DNS credential and it lands under exactly one name.
      expect(env.HETZNER_API_TOKEN).toBeUndefined();
      expect(env.DO_AUTH_TOKEN).toBeUndefined();
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('injects the consolidated Hetzner Cloud token for the hetzner provider', () => {
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      dnsChallenge: true,
      dnsProvider: 'hetzner',
      dnsToken: 'hz-tok',
    });

    try {
      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.ACME_DNS_PROVIDER).toBe('hetzner');
      expect(env.HETZNER_API_TOKEN).toBe('hz-tok');
      expect(env.CF_DNS_API_TOKEN).toBeUndefined();
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('injects the lego-named token var for each newly wired provider', () => {
    // lego reads a different env var name per provider; the bundler writes
    // the one selected provider's, under lego's name (not the CLI's).
    const cases: Array<[string, string]> = [
      ['digitalocean', 'DO_AUTH_TOKEN'],
      ['linode', 'LINODE_TOKEN'],
      ['vultr', 'VULTR_API_KEY'],
    ];
    for (const [dnsProvider, tokenVar] of cases) {
      projectDir = makeProjectDir('');
      process.chdir(projectDir);

      const stage = renderBundle('myproj', { dnsChallenge: true, dnsProvider, dnsToken: 'tok' });

      try {
        const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
        expect(env.ACME_DNS_PROVIDER).toBe(dnsProvider);
        expect(env[tokenVar]).toBe('tok');
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
  });

  it('leaves HTTP-01 untouched when dnsChallenge is not set (manual DNS)', () => {
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {});

    try {
      const reconcile = readFileSync(join(stage, 'reconcile.sh'), 'utf-8');
      expect(reconcile).not.toContain('docker-compose.dns01.prod.yml');

      const env = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(env.ACME_DNS_PROVIDER).toBeUndefined();
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

  it('writes tls-default.yml with wildcard SAN for DNS-01 (cloudflare) deploy', () => {
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      domain: 'e1.carbonstack.dev',
      dnsChallenge: true,
      dnsProvider: 'cloudflare',
      dnsToken: 'cf-tok',
    });

    try {
      const tls = readFileSync(join(stage, 'volumes', 'traefik', 'tls-default.yml'), 'utf-8');
      // default cert is the wildcard (subdomains); the apex app owns its own cert
      expect(tls).toContain('main: "*.e1.carbonstack.dev"');
      expect(tls).not.toContain('main: "e1.carbonstack.dev"');
      expect(tls).not.toContain('api.e1.carbonstack.dev');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it('writes tls-default.yml with explicit subdomain SANs for HTTP-01 deploy', () => {
    projectDir = makeProjectDir('');
    process.chdir(projectDir);

    const stage = renderBundle('myproj', {
      domain: 'e1.carbonstack.dev',
      dnsChallenge: false,
      observability: true,
    });

    try {
      const tls = readFileSync(join(stage, 'volumes', 'traefik', 'tls-default.yml'), 'utf-8');
      // HTTP-01: studio.<domain> is main; apex app owns its own cert; no
      // wildcard; no api. host exists under single-origin routing
      expect(tls).toContain('main: "studio.e1.carbonstack.dev"');
      expect(tls).not.toContain('main: "e1.carbonstack.dev"');
      expect(tls).not.toContain('api.e1.carbonstack.dev');
      expect(tls).toContain('grafana.e1.carbonstack.dev');
      expect(tls).not.toContain('*.');
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
});
