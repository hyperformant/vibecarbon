import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DNS01_OVERRIDE_FILE,
  dnsChallengeEnv,
  useDnsChallenge,
} from '../../../src/lib/deploy/acme.js';
import { DNS01_PROVIDERS } from '../../../src/lib/dns-provider.js';

/**
 * Token env var lego (Traefik's embedded ACME client) reads per provider,
 * pinned as literals from the lego docs (go-acme.github.io/lego/dns/<code>/)
 * rather than derived from DNS01_PROVIDERS — a test that re-reads the table
 * it is guarding proves nothing. The exhaustiveness check below makes adding
 * a row without pinning its env var here a failure.
 */
const LEGO_TOKEN_ENV: Record<string, string> = {
  cloudflare: 'CF_DNS_API_TOKEN',
  hetzner: 'HETZNER_API_TOKEN',
  digitalocean: 'DO_AUTH_TOKEN',
  linode: 'LINODE_TOKEN',
  vultr: 'VULTR_API_KEY',
  // lego's REQUIRED var. SCW_ACCESS_KEY and SCW_PROJECT_ID are optional there,
  // so the one-token-per-row contract survives Scaleway's three-part
  // credential; note this is the plugin-native spelling, NOT the CLI's
  // operator-facing SCALEWAY_SECRET_KEY.
  scaleway: 'SCW_SECRET_KEY',
};

describe('useDnsChallenge', () => {
  it('is true for every DNS-01 provider', () => {
    for (const provider of Object.keys(LEGO_TOKEN_ENV)) {
      expect(useDnsChallenge(provider)).toBe(true);
    }
  });

  it('is false for manual DNS and unknown/empty providers', () => {
    expect(useDnsChallenge('manual')).toBe(false);
    expect(useDnsChallenge(null)).toBe(false);
    expect(useDnsChallenge(undefined)).toBe(false);
    expect(useDnsChallenge('')).toBe(false);
  });
});

describe('dnsChallengeEnv', () => {
  it('returns null for manual / non-DNS-01 providers', () => {
    expect(dnsChallengeEnv('manual', 'x')).toBeNull();
    expect(dnsChallengeEnv('route53', 'x')).toBeNull();
    expect(dnsChallengeEnv(undefined)).toBeNull();
  });

  it('selects the cloudflare token env var for cloudflare', () => {
    expect(dnsChallengeEnv('cloudflare', 'cf-tok')).toEqual({
      ACME_DNS_PROVIDER: 'cloudflare',
      CF_DNS_API_TOKEN: 'cf-tok',
    });
  });

  it('selects the (consolidated Cloud) token env var for hetzner', () => {
    expect(dnsChallengeEnv('hetzner', 'hz-tok')).toEqual({
      ACME_DNS_PROVIDER: 'hetzner',
      HETZNER_API_TOKEN: 'hz-tok',
    });
  });

  it('selects DO_AUTH_TOKEN for digitalocean', () => {
    expect(dnsChallengeEnv('digitalocean', 'do-tok')).toEqual({
      ACME_DNS_PROVIDER: 'digitalocean',
      DO_AUTH_TOKEN: 'do-tok',
    });
  });

  it('selects LINODE_TOKEN for linode', () => {
    expect(dnsChallengeEnv('linode', 'li-tok')).toEqual({
      ACME_DNS_PROVIDER: 'linode',
      LINODE_TOKEN: 'li-tok',
    });
  });

  it('selects VULTR_API_KEY for vultr', () => {
    expect(dnsChallengeEnv('vultr', 'vu-tok')).toEqual({
      ACME_DNS_PROVIDER: 'vultr',
      VULTR_API_KEY: 'vu-tok',
    });
  });

  it('selects SCW_SECRET_KEY for scaleway (not the operator-facing SCALEWAY_SECRET_KEY)', () => {
    expect(dnsChallengeEnv('scaleway', 'scw-tok')).toEqual({
      ACME_DNS_PROVIDER: 'scaleway',
      SCW_SECRET_KEY: 'scw-tok',
    });
  });

  it('omits the token key when the token is missing (no literal undefined in .env)', () => {
    for (const provider of Object.keys(LEGO_TOKEN_ENV)) {
      expect(dnsChallengeEnv(provider)).toEqual({ ACME_DNS_PROVIDER: provider });
      expect(dnsChallengeEnv(provider, '')).toEqual({ ACME_DNS_PROVIDER: provider });
    }
  });

  it('exposes the override filename constant', () => {
    expect(DNS01_OVERRIDE_FILE).toBe('docker-compose.dns01.prod.yml');
  });
});

describe('DNS01_PROVIDERS lego contract (census)', () => {
  it('covers exactly the providers pinned above — a new row must pin its lego env var here', () => {
    expect(Object.keys(DNS01_PROVIDERS).sort()).toEqual(Object.keys(LEGO_TOKEN_ENV).sort());
  });

  it('every row drives lego with ACME_DNS_PROVIDER = its own id and only its own token var', () => {
    for (const [provider, tokenEnvVar] of Object.entries(LEGO_TOKEN_ENV)) {
      const env = dnsChallengeEnv(provider, 'tok') as Record<string, string>;
      // lego's provider code equals our provider id for all five (verified
      // against go-acme.github.io/lego/dns/), so no translation layer exists.
      expect(env.ACME_DNS_PROVIDER).toBe(provider);
      expect(env[tokenEnvVar]).toBe('tok');
      // Exactly two keys: the selector and this provider's token. No other
      // provider's token leaks into the server .env.
      expect(Object.keys(env).sort()).toEqual(['ACME_DNS_PROVIDER', tokenEnvVar].sort());
    }
  });

  it('the Traefik DNS-01 override passes every token env var through to the container', () => {
    // The bundler writes the selected provider's token into the server .env,
    // but Traefik only sees what the override's `environment:` list forwards.
    // A row whose var is missing here yields a Traefik that reports "no
    // credentials" minutes into issuance instead of failing at deploy.
    const override = readFileSync(
      join(__dirname, '../../..', 'carbon', DNS01_OVERRIDE_FILE),
      'utf-8',
    );
    for (const row of Object.values(DNS01_PROVIDERS)) {
      // Absent vars interpolate to empty, so passing all of them through is
      // safe — only the selected provider's is ever populated.
      expect(override).toContain(`${row.tokenEnvVar}: \${${row.tokenEnvVar}:-}`);
    }
  });
});
