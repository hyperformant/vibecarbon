import { describe, expect, it } from 'vitest';
import { registryEntry } from '../../../src/lib/config-registry.js';
import {
  checkOperatorConfig,
  normalizeOperatorValue,
  readOperatorVar,
  validateOperatorValue,
} from '../../../src/lib/operator-env.js';

/** registryEntry(key), asserted present — throws loudly instead of a non-null assertion. */
function entry(key: string) {
  const found = registryEntry(key);
  if (!found) throw new Error(`test setup: no registry entry for ${key}`);
  return found;
}

const hetzner = entry('HETZNER_API_TOKEN');
const stripe = entry('STRIPE_SECRET_KEY');
const pem = {
  key: 'X_PEM',
  class: 'operator-secret',
  feature: 'e2e',
  kind: 'pem',
  where: 'tests/.env.e2e',
  scope: 'e2e',
} as const;
const good64 = 'a'.repeat(64);

describe('normalizeOperatorValue', () => {
  it('trims whitespace and newlines', () => {
    expect(normalizeOperatorValue(`  ${good64}\n`, hetzner)).toEqual({
      value: good64,
      fixed: ['trimmed whitespace'],
    });
  });
  it('strips one pair of matching surrounding quotes', () => {
    expect(normalizeOperatorValue(`"${good64}"`, hetzner).value).toBe(good64);
    expect(normalizeOperatorValue(`'${good64}'`, hetzner).value).toBe(good64);
    expect(normalizeOperatorValue(`"${good64}'`, hetzner).value).toBe(`"${good64}'`);
  });
  it('strips a Bearer prefix for tokens only', () => {
    expect(normalizeOperatorValue(`Bearer ${good64}`, hetzner)).toEqual({
      value: good64,
      fixed: ['removed "Bearer " prefix'],
    });
    expect(normalizeOperatorValue('Bearer x', entry('SMTP_HOST')).value).toBe('Bearer x');
  });
  it('expands \\n escapes and decodes base64 for pem', () => {
    const p = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(normalizeOperatorValue(p.replace(/\n/g, '\\n'), pem).value).toBe(p);
    expect(normalizeOperatorValue(Buffer.from(p).toString('base64'), pem).value).toBe(p);
    expect(normalizeOperatorValue(p, pem).fixed).toEqual([]);
  });
  it('returns empty for null/undefined', () => {
    expect(normalizeOperatorValue(undefined, hetzner)).toEqual({ value: '', fixed: [] });
  });
  it('leaves a non-PEM value untouched rather than trusting a garbage base64 decode', () => {
    const garbage = 'plainly-not-a-pem-or-base64!!';
    expect(normalizeOperatorValue(garbage, pem)).toEqual({ value: garbage, fixed: [] });
  });
});

describe('validateOperatorValue', () => {
  it('accepts a matching value', () => expect(validateOperatorValue(good64, hetzner)).toBeNull());
  it('names the variable, the expected shape, and the observed length — never the value', () => {
    const msg = validateOperatorValue(`${good64}x`, hetzner);
    expect(msg).toBe(
      'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 65 characters',
    );
    expect(msg).not.toContain('aaaa');
  });
  it('hints at the classic paste mistakes', () => {
    expect(validateOperatorValue(`${good64}\n`, hetzner)).toContain('trailing newline');
    expect(validateOperatorValue(`"${good64}"`, hetzner)).toContain('surrounding quotes');
  });
  // M10 (review 2026-09-19): every real caller validates the NORMALIZED value
  // and threads the raw paste through `opts.raw`, so the hint keys off what
  // the operator actually typed — a wrapped-but-valid token is simply fine,
  // a wrapped-and-invalid one gets told about the quotes.
  describe('opts.raw — the paste hint keys off the raw string, not the normalized one', () => {
    it('a quote-wrapped VALID token, validated normalized, yields no problem', () => {
      const raw = `"${good64}"`;
      const { value } = normalizeOperatorValue(raw, hetzner);
      expect(validateOperatorValue(value, hetzner, { raw })).toBeNull();
    });
    it('a quote-wrapped INVALID token, validated normalized, still carries the surrounding-quotes hint', () => {
      const raw = '"abc"';
      const { value } = normalizeOperatorValue(raw, hetzner);
      expect(validateOperatorValue(value, hetzner, { raw })).toBe(
        'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 3 characters — surrounding quotes?',
      );
    });
    it('a trailing-newline INVALID token, validated normalized, carries the newline hint', () => {
      const raw = 'abc\n';
      const { value } = normalizeOperatorValue(raw, hetzner);
      expect(validateOperatorValue(value, hetzner, { raw })).toContain('a trailing newline?');
    });
    it('without opts.raw the normalized value carries no hint (nothing to hint about)', () => {
      expect(validateOperatorValue('abc', hetzner)).toBe(
        'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 3 characters',
      );
    });
  });
  it('reports a missing required value', () => {
    expect(validateOperatorValue('', hetzner)).toBe('HETZNER_API_TOKEN is not set');
    expect(validateOperatorValue('', entry('HETZNER_STORAGE_REGION'))).toBeNull();
  });
  it('checks kind rules without a regex: port, email, hostname, url, cidr-list, enum, minLen', () => {
    expect(validateOperatorValue('70000', entry('SMTP_PORT'))).toContain('1-65535');
    expect(validateOperatorValue('not-an-email', entry('SMTP_ADMIN_EMAIL'))).toContain('email');
    expect(validateOperatorValue('http://x', entry('ACME_CA_SERVER'))).toContain('https://');
    expect(validateOperatorValue('10.0.0.0/8,garbage', entry('ALLOWED_SSH_IPS'))).toContain(
      'CIDRs',
    );
    expect(validateOperatorValue('paypal', entry('BILLING_PROVIDER'))).toContain('one of');
    expect(validateOperatorValue('short', entry('LINODE_API_TOKEN'))).toContain('at least');
    expect(validateOperatorValue('sk_test_abc', stripe)).toBeNull();
  });
  // A2-A4 (review 2026-09-19): a tight regex only where the documented format
  // is the ONLY one the vendor accepts. These values are all accepted by
  // their vendors and were wrongly refused before.
  it('accepts vendor-valid values the earlier tight regexes rejected', () => {
    // Stripe restricted keys.
    expect(validateOperatorValue('rk_live_abcDEF123', stripe)).toBeNull();
    expect(validateOperatorValue('rk_test_abcDEF123', stripe)).toBeNull();
    expect(validateOperatorValue('sk_live_abcDEF123', stripe)).toBeNull();
    expect(validateOperatorValue('pk_test_abcDEF123', stripe)).toBe(
      'STRIPE_SECRET_KEY looks wrong: expected sk_live_…, sk_test_… or a restricted rk_… key, got 17 characters',
    );
    // Docker Hub: account passwords, legacy UUID tokens, dckr_oat_ org tokens.
    const dockerHub = entry('DOCKER_HUB_TOKEN');
    expect(validateOperatorValue('dckr_pat_AbCdEf1234567890-xyz', dockerHub)).toBeNull();
    expect(validateOperatorValue('dckr_oat_AbCdEf1234567890-xyz', dockerHub)).toBeNull();
    expect(validateOperatorValue('12345678-1234-4123-8123-123456789012', dockerHub)).toBeNull();
    expect(validateOperatorValue('my-account-password', dockerHub)).toBeNull();
    expect(validateOperatorValue('short', dockerHub)).toBe(
      'DOCKER_HUB_TOKEN looks wrong: expected a Docker Hub access token or password, got 5 characters',
    );
    // Google: pre-2021 client secrets have no GOCSPX- prefix.
    const google = entry('GOOGLE_CLIENT_SECRET');
    expect(validateOperatorValue('GOCSPX-AbCdEf1234567890ghijk', google)).toBeNull();
    expect(validateOperatorValue('AbCdEf1234567890ghijklmn', google)).toBeNull();
    expect(validateOperatorValue('tooshort', google)).toBe(
      'GOOGLE_CLIENT_SECRET looks wrong: expected at least 16 characters, got 8 characters',
    );
  });
  it('pins the shape-less hostname/url fallbacks against real registry entries', () => {
    const smtpHost = entry('SMTP_HOST');
    expect(validateOperatorValue('smtp.example.com', smtpHost)).toBeNull();
    expect(validateOperatorValue('mail.internal', smtpHost)).toBeNull();
    const badHost = 'not a host';
    expect(validateOperatorValue(badHost, smtpHost)).toBe(
      `SMTP_HOST looks wrong: expected a hostname, got ${badHost.length} characters`,
    );
    const urlAsHost = 'http://smtp.example.com';
    expect(validateOperatorValue(urlAsHost, smtpHost)).toBe(
      `SMTP_HOST looks wrong: expected a hostname, got ${urlAsHost.length} characters`,
    );

    const githubUrl = entry('VITE_GITHUB_REPO_URL');
    expect(validateOperatorValue('https://github.com/x/y', githubUrl)).toBeNull();
    const bareUrl = 'github.com/x/y';
    expect(validateOperatorValue(bareUrl, githubUrl)).toBe(
      `VITE_GITHUB_REPO_URL looks wrong: expected a URL, got ${bareUrl.length} characters`,
    );
  });
  it('pins the shape-less port/email/cidr-list/pem fallbacks (entries constructed inline, no shape)', () => {
    const portEntry = {
      key: 'T_PORT',
      class: 'operator-secret',
      feature: 'e2e',
      kind: 'port',
      where: 'tests/.env.e2e',
      scope: 'e2e',
    } as const;
    expect(validateOperatorValue('8080', portEntry)).toBeNull();
    for (const bad of ['0', '70000', 'abc']) {
      expect(validateOperatorValue(bad, portEntry)).toBe(
        `T_PORT looks wrong: expected 1-65535, got ${bad.length} characters`,
      );
    }

    const emailEntry = {
      key: 'T_EMAIL',
      class: 'operator-secret',
      feature: 'e2e',
      kind: 'email',
      where: 'tests/.env.e2e',
      scope: 'e2e',
    } as const;
    expect(validateOperatorValue('a@b.co', emailEntry)).toBeNull();
    expect(validateOperatorValue('x@', emailEntry)).toBe(
      'T_EMAIL looks wrong: expected an email address, got 2 characters',
    );

    const cidrEntry = {
      key: 'T_CIDR',
      class: 'operator-secret',
      feature: 'e2e',
      kind: 'cidr-list',
      where: 'tests/.env.e2e',
      scope: 'e2e',
    } as const;
    // A5 (review 2026-09-19): nobody documents a format for this list and the
    // parser it feeds always took bare addresses and IPv6 — accept anything
    // that IS an address (v4/v6, optional /mask in range), reject only
    // non-addresses and out-of-range masks.
    const cidrDescribe = 'comma-separated IPv4/IPv6 addresses or CIDRs like 203.0.113.0/24';
    for (const ok of [
      '10.0.0.0/8, 192.168.1.0/24',
      '203.0.113.5',
      '2001:db8::1/128',
      '::1',
      '203.0.113.0/24,2001:db8::/32',
      '0.0.0.0/0',
    ]) {
      expect(validateOperatorValue(ok, cidrEntry), ok).toBeNull();
    }
    for (const bad of [
      'garbage',
      '10.0.0.0/99',
      '2001:db8::1/129',
      '10.0.0.0/',
      '10.0.0.0/8,',
      '999.1.1.1',
    ]) {
      expect(validateOperatorValue(bad, cidrEntry), bad).toBe(
        `T_CIDR looks wrong: expected ${cidrDescribe}, got ${bad.length} characters`,
      );
    }
    // The real entry has no `shape` and rides this same fallback.
    expect(
      validateOperatorValue('2001:db8::1/128, 203.0.113.5', entry('ALLOWED_SSH_IPS')),
    ).toBeNull();
    expect(validateOperatorValue('garbage', entry('ALLOWED_SSH_IPS'))).toContain(cidrDescribe);

    const p = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(validateOperatorValue(p, pem)).toBeNull();
    const garbage = 'plainly-not-a-pem-or-base64!!';
    expect(validateOperatorValue(garbage, pem)).toBe(
      `X_PEM looks wrong: expected a PEM block (or its base64 encoding), got ${garbage.length} characters`,
    );
  });
});

describe('readOperatorVar', () => {
  it('normalizes then validates from the given env', () => {
    expect(
      readOperatorVar('HETZNER_API_TOKEN', { env: { HETZNER_API_TOKEN: `"${good64}"\n` } }),
    ).toEqual({
      value: good64,
      problem: null,
      fixed: ['trimmed whitespace', 'stripped surrounding quotes'],
    });
  });
  it('returns null value + problem when missing', () => {
    expect(readOperatorVar('HETZNER_API_TOKEN', { env: {} })).toEqual({
      value: null,
      problem: 'HETZNER_API_TOKEN is not set',
      fixed: [],
    });
  });
  it('passes through an unregistered key untouched (no problem, no normalization)', () => {
    expect(readOperatorVar('NOT_IN_REGISTRY', { env: { NOT_IN_REGISTRY: ' x ' } })).toEqual({
      value: ' x ',
      problem: null,
      fixed: [],
    });
  });
});

describe('checkOperatorConfig', () => {
  it('aggregates every problem for the selected scopes and lists what it checked', () => {
    const r = checkOperatorConfig(['provider:hetzner', 'dns:cloudflare'], {
      env: {
        HETZNER_API_TOKEN: 'short',
        HETZNER_ACCESS_KEY: 'k'.repeat(20),
        HETZNER_SECRET_KEY: 's'.repeat(40),
      },
    });
    expect(r.problems).toEqual([
      'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 5 characters',
      'CLOUDFLARE_API_TOKEN is not set',
    ]);
    expect(r.checked).toContain('HETZNER_STORAGE_REGION');
  });
  it('is clean when everything is set and shaped', () => {
    expect(
      checkOperatorConfig(['provider:hetzner'], {
        env: {
          HETZNER_API_TOKEN: good64,
          HETZNER_ACCESS_KEY: 'k'.repeat(20),
          HETZNER_SECRET_KEY: 's'.repeat(40),
        },
      }).problems,
    ).toEqual([]);
  });

  describe('presence: false', () => {
    it('tolerates an absent required key (no "is not set" problem)', () => {
      expect(
        checkOperatorConfig(['provider:hetzner'], { presence: false, env: {} }).problems,
      ).toEqual([]);
    });

    it('still reports a PRESENT but malformed value — presence never covers shape', () => {
      expect(
        checkOperatorConfig(['provider:hetzner'], {
          presence: false,
          env: { HETZNER_API_TOKEN: 'short' },
        }).problems,
      ).toEqual([
        'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 5 characters',
      ]);
    });

    it('defaults to true (an absent required key IS a problem) when omitted', () => {
      expect(checkOperatorConfig(['provider:hetzner'], { env: {} }).problems).toContain(
        'HETZNER_API_TOKEN is not set',
      );
    });
  });

  describe('keys', () => {
    it('checks an individually-named registered key not covered by scopes', () => {
      const r = checkOperatorConfig(['tls'], {
        keys: ['CLOUDFLARE_API_TOKEN'],
        env: { CLOUDFLARE_API_TOKEN: '' },
      });
      expect(r.problems).toEqual(['CLOUDFLARE_API_TOKEN is not set']);
      expect(r.checked).toContain('CLOUDFLARE_API_TOKEN');
    });

    it('is combined with presence: false the same way a scope-covered key is', () => {
      expect(
        checkOperatorConfig([], {
          presence: false,
          keys: ['CLOUDFLARE_API_TOKEN'],
          env: {},
        }).problems,
      ).toEqual([]);
    });

    it('an unregistered key name is silently ignored (never a crash)', () => {
      expect(checkOperatorConfig([], { keys: ['NOT_A_REGISTERED_KEY'], env: {} }).problems).toEqual(
        [],
      );
    });

    it('a key already covered by a scope is not checked twice', () => {
      const r = checkOperatorConfig(['provider:hetzner'], {
        keys: ['HETZNER_API_TOKEN'],
        env: {
          HETZNER_API_TOKEN: 'short',
          HETZNER_ACCESS_KEY: 'k'.repeat(20),
          HETZNER_SECRET_KEY: 's'.repeat(40),
        },
      });
      expect(r.problems).toHaveLength(1);
      expect(r.checked.filter((k) => k === 'HETZNER_API_TOKEN')).toHaveLength(1);
    });
  });
});
