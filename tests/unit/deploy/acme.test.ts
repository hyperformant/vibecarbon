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

  it('selects the (consolidated Cloud) token env var for hetzner (plus its propagation tuning)', () => {
    expect(dnsChallengeEnv('hetzner', 'hz-tok')).toEqual({
      ACME_DNS_PROVIDER: 'hetzner',
      HETZNER_API_TOKEN: 'hz-tok',
      HETZNER_PROPAGATION_TIMEOUT: '300',
      ACME_DNS_DELAY_BEFORE_CHECKS: '90s',
    });
  });

  it('selects DO_AUTH_TOKEN for digitalocean (plus its lego propagation tuning)', () => {
    expect(dnsChallengeEnv('digitalocean', 'do-tok')).toEqual({
      ACME_DNS_PROVIDER: 'digitalocean',
      DO_AUTH_TOKEN: 'do-tok',
      DO_PROPAGATION_TIMEOUT: '300',
      ACME_DNS_DELAY_BEFORE_CHECKS: '90s',
    });
  });

  it('selects LINODE_TOKEN for linode', () => {
    expect(dnsChallengeEnv('linode', 'li-tok')).toEqual({
      ACME_DNS_PROVIDER: 'linode',
      LINODE_TOKEN: 'li-tok',
    });
  });

  it('selects VULTR_API_KEY for vultr (plus its negative-cache tuning row)', () => {
    expect(dnsChallengeEnv('vultr', 'vu-tok')).toEqual({
      ACME_DNS_PROVIDER: 'vultr',
      VULTR_API_KEY: 'vu-tok',
      VULTR_PROPAGATION_TIMEOUT: '300',
      ACME_DNS_DELAY_BEFORE_CHECKS: '60s',
    });
  });

  it('selects SCW_SECRET_KEY for scaleway (not the operator-facing SCALEWAY_SECRET_KEY)', () => {
    expect(dnsChallengeEnv('scaleway', 'scw-tok')).toEqual({
      ACME_DNS_PROVIDER: 'scaleway',
      SCW_SECRET_KEY: 'scw-tok',
    });
  });

  it('omits the token key when the token is missing (no literal undefined in .env)', () => {
    for (const [provider, tokenEnvVar] of Object.entries(LEGO_TOKEN_ENV)) {
      for (const token of [undefined, '']) {
        const env = dnsChallengeEnv(provider, token) as Record<string, string>;
        expect(env.ACME_DNS_PROVIDER).toBe(provider);
        // The point of this test: no token key, ever, when no token was given.
        // (A row's lego tuning keys may still be present — they're constants,
        // not credentials.)
        expect(env).not.toHaveProperty(tokenEnvVar);
      }
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
      // Exactly the selector, this provider's token, and this provider's own
      // lego tuning keys (if any). No other provider's token or tuning leaks
      // into the server .env.
      const tuningKeys = Object.keys(DNS01_PROVIDERS[provider].legoTuningEnv ?? {});
      expect(Object.keys(env).sort()).toEqual(
        ['ACME_DNS_PROVIDER', tokenEnvVar, ...tuningKeys].sort(),
      );
    }
  });

  it("digitalocean tunes lego's propagation window — DO's authoritative anycast outlives the 60s default", () => {
    // Run 33266321881: lego's per-attempt propagation wait (DO_PROPAGATION_TIMEOUT,
    // default 60s per go-acme.github.io/lego/dns/digitalocean/) expired before
    // DO's OWN authoritative nameservers served the challenge TXT
    // ("NS ns1.digitalocean.com:53 did not return the expected TXT record").
    // Each failed attempt then rewrites the TXT value, so issuance churns
    // instead of converging — and stale values at anycast POPs 403 the next
    // attempt ("Incorrect TXT record ... found"). A longer per-attempt wait
    // lets one attempt outlive the anycast convergence.
    const env = dnsChallengeEnv('digitalocean', 'tok') as Record<string, string>;
    expect(env.DO_PROPAGATION_TIMEOUT).toBe('300');
    // Settle FLOOR before lego's own propagation check (Traefik
    // dnschallenge.propagation.delayBeforeChecks): run 33283466928 showed
    // lego's anycast POP converging fast while LE's validation POP still
    // answered "No TXT record found" — the record needs wall-time in the
    // zone, not just visibility from one vantage.
    expect(env.ACME_DNS_DELAY_BEFORE_CHECKS).toBe('90s');
  });

  it("the DNS-01 override's Traefik command consults the delay-before-checks var", () => {
    const override = readFileSync(
      join(__dirname, '../../..', 'carbon', DNS01_OVERRIDE_FILE),
      'utf-8',
    );
    expect(override).toContain(
      'acme.dnschallenge.propagation.delaybeforechecks=${ACME_DNS_DELAY_BEFORE_CHECKS:-0s}',
    );
  });

  it("vultr floors lego's first check past the zone's negative-cache poisoning window", () => {
    // 2026-08-30 RCA (run 33287840597 vultr compose-ha; scripts/acme-iso
    // trials + direct API/dig probes on threvidence.com): Vultr's
    // authoritative frontends NEGATIVELY CACHE a name queried before its
    // record lands. An unqueried record serves in <=5s; one pre-creation
    // query makes the same record invisible for minutes. lego at
    // delayBeforeChecks=0s queries the instant it presents — poisoning its
    // own challenge name, then polling the poisoned cache until timeout
    // ("NS ns1.vultr.com:53 returned NXDOMAIN for _acme-challenge...", or
    // a concurrent order's stale token). The floor means the FIRST query
    // happens after the record is live, so no negative entry ever forms;
    // the 300s window covers cache-expiry stragglers on churned names.
    const env = dnsChallengeEnv('vultr', 'tok') as Record<string, string>;
    expect(env.VULTR_PROPAGATION_TIMEOUT).toBe('300');
    expect(env.ACME_DNS_DELAY_BEFORE_CHECKS).toBe('60s');
  });

  it('hetzner carries the 300s window AND the 90s settle floor (unwound 2026-09-01)', () => {
    // UNWIND of the 2026-08-31 timeout-only decision (run 33341893276).
    // That RCA correctly proved hetzner has NO vultr-style
    // query-before-create poisoning and then rejected the settle floor —
    // but it evaluated the floor against the wrong mechanism. The floor's
    // proven role (DO, run 33283466928) is bridging lego's vantage to LE's
    // remote validators; hetzner's own characterization showed that
    // exposure (twin records visible 20s vs 90s+ apart across the anycast
    // NS in degraded windows), and the first post-fix dispatches
    // (33435737752) failed on exactly the vantage-divergence spellings
    // ("No TXT record found" / "During secondary validation: Incorrect
    // TXT record") with the 300s window active. The floor costs ~40s per
    // COLD compose issuance and nothing on warm deploys; a lost deploy to
    // a degraded window costs the run.
    const env = dnsChallengeEnv('hetzner', 'tok') as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(
      [
        'ACME_DNS_PROVIDER',
        'HETZNER_API_TOKEN',
        'HETZNER_PROPAGATION_TIMEOUT',
        'ACME_DNS_DELAY_BEFORE_CHECKS',
      ].sort(),
    );
    expect(env.HETZNER_PROPAGATION_TIMEOUT).toBe('300');
    expect(env.ACME_DNS_DELAY_BEFORE_CHECKS).toBe('90s');
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
      // Same contract for a row's lego tuning vars: dnsChallengeEnv writing a
      // tuning value into the server .env is inert unless the override
      // forwards it into the traefik container.
      for (const tuningVar of Object.keys(row.legoTuningEnv ?? {})) {
        expect(override).toContain(`${tuningVar}: \${${tuningVar}:-}`);
      }
    }
  });
});
