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
  it('reports a missing required value', () => {
    expect(validateOperatorValue('', hetzner)).toBe('HETZNER_API_TOKEN is not set');
    expect(validateOperatorValue('', entry('HETZNER_STORAGE_REGION'))).toBeNull();
  });
  it('checks kind rules without a regex: port, email, hostname, url, cidr-list, enum, minLen', () => {
    expect(validateOperatorValue('70000', entry('SMTP_PORT'))).toContain('1-65535');
    expect(validateOperatorValue('not-an-email', entry('SMTP_ADMIN_EMAIL'))).toContain('email');
    expect(validateOperatorValue('http://x', entry('ACME_CA_SERVER'))).toContain('https://');
    expect(validateOperatorValue('10.0.0.0/8,garbage', entry('ALLOWED_SSH_IPS'))).toContain('CIDR');
    expect(validateOperatorValue('paypal', entry('BILLING_PROVIDER'))).toContain('one of');
    expect(validateOperatorValue('short', entry('LINODE_API_TOKEN'))).toContain('at least');
    expect(validateOperatorValue('sk_test_abc', stripe)).toBeNull();
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
});
