/**
 * scripts/generate-license.js: the operator-facing minting script for both
 * key formats. Exercised in-process (importing the script's exported
 * helpers against an ephemeral keypair) rather than by spawning a process,
 * per the brief - cheap and the script is importable specifically for this.
 */
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  derivePublicKeyPem,
  emailToCustomerId,
  mintV1Key,
  mintV2Key,
  monthsAheadUTC,
  parseArgs,
  resolvePaidThrough,
  run,
} from '../../../scripts/generate-license.js';
import { validateLicenseKey } from '../../../src/lib/licensing/validator.js';

function ephemeralPrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

describe('parseArgs', () => {
  it('accepts single-dash flags', () => {
    const opts = parseArgs([
      '-legacy',
      '-tier',
      'fullerene',
      '-project',
      PROJECT_ID,
      '-months',
      '1',
    ]);
    expect(opts.legacy).toBe(true);
    expect(opts.tier).toBe('fullerene');
    expect(opts.project).toBe(PROJECT_ID);
    expect(opts.months).toBe('1');
  });

  it('also accepts double-dash flags (back-compat with older docs/scripts)', () => {
    const opts = parseArgs([
      '--tier',
      'graphene',
      '--email',
      'user@acme.com',
      '--paid-through',
      '2027-01-31',
    ]);
    expect(opts.tier).toBe('graphene');
    expect(opts.email).toBe('user@acme.com');
    expect(opts.paidThrough).toBe('2027-01-31');
  });

  it('defaults to v2/graphene, no legacy', () => {
    const opts = parseArgs([]);
    expect(opts.legacy).toBe(false);
    expect(opts.tier).toBe('graphene');
  });
});

describe('monthsAheadUTC', () => {
  it('adds whole calendar months in UTC', () => {
    const now = new Date(Date.UTC(2026, 0, 15)); // 2026-01-15
    expect(monthsAheadUTC(1, now)).toBe('2026-02-15');
    expect(monthsAheadUTC(12, now)).toBe('2027-01-15');
  });

  it('clamps to the last day of a shorter target month (Jan 31 + 1 month)', () => {
    const nonLeapJan31 = new Date(Date.UTC(2027, 0, 31)); // 2027 is not a leap year
    expect(monthsAheadUTC(1, nonLeapJan31)).toBe('2027-02-28');

    const leapJan31 = new Date(Date.UTC(2028, 0, 31)); // 2028 is a leap year
    expect(monthsAheadUTC(1, leapJan31)).toBe('2028-02-29');
  });
});

describe('resolvePaidThrough', () => {
  const now = new Date(Date.UTC(2026, 0, 15));

  it('uses -paid-through verbatim when given', () => {
    expect(resolvePaidThrough({ paidThrough: '2027-06-30', months: null }, now)).toBe('2027-06-30');
  });

  it('derives from -months when given', () => {
    expect(resolvePaidThrough({ paidThrough: null, months: '2' }, now)).toBe('2026-03-15');
  });

  it('throws when neither is given', () => {
    expect(() => resolvePaidThrough({ paidThrough: null, months: null }, now)).toThrow(
      /paid-through.*or.*-months.*required/i,
    );
  });

  it('throws when both are given', () => {
    expect(() => resolvePaidThrough({ paidThrough: '2027-06-30', months: '2' }, now)).toThrow(
      /only one/i,
    );
  });
});

describe('minting round-trips against the matching public key', () => {
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeEach(() => {
    privateKeyPem = ephemeralPrivateKeyPem();
    publicKeyPem = derivePublicKeyPem(privateKeyPem);
  });

  it('mintV1Key produces a key that validates as v1/fullerene/lifetime', () => {
    const key = mintV1Key(privateKeyPem, { customerId: 'a1b2c3d4' });
    const result = validateLicenseKey(key, { publicKeyPem });
    expect(result.valid).toBe(true);
    expect(result.format).toBe('v1');
    expect(result.tier).toBe('fullerene');
    expect(result.isLifetime).toBe(true);
  });

  it('mintV2Key produces a key that validates as v2 with the right project/paidThrough', () => {
    const key = mintV2Key(privateKeyPem, {
      tier: 'graphene',
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      paidThrough: '2027-12-31',
    });
    const result = validateLicenseKey(key, { publicKeyPem });
    expect(result.valid).toBe(true);
    expect(result.format).toBe('v2');
    expect(result.tier).toBe('graphene');
    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.paidThrough).toBe('2027-12-31');
    expect(result.isLifetime).toBe(false);
  });

  it('a v2 key does NOT validate against an unrelated public key', () => {
    const key = mintV2Key(privateKeyPem, {
      tier: 'fullerene',
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      paidThrough: '2027-12-31',
    });
    const otherPublicKeyPem = derivePublicKeyPem(ephemeralPrivateKeyPem());
    expect(validateLicenseKey(key, { publicKeyPem: otherPublicKeyPem }).valid).toBe(false);
  });
});

describe('run() end to end', () => {
  let privateKeyPem: string;

  beforeEach(() => {
    privateKeyPem = ephemeralPrivateKeyPem();
  });

  it('mints and prints a v2 key from -months, and returns a valid validation result', () => {
    const lines: string[] = [];
    const now = new Date(Date.UTC(2026, 0, 15));
    const result = run(['-project', PROJECT_ID, '-months', '1', '-email', 'user@acme.com'], {
      privateKeyPem,
      log: (s) => lines.push(s),
      now,
    });

    expect(result.printed).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.format).toBe('v2');
    expect(result.validation.paidThrough).toBe('2026-02-15');
    const output = lines.join('\n');
    expect(output).toContain('Tier:       Graphene');
    expect(output).toContain(`Project:    ${PROJECT_ID}`);
    expect(output).toContain('Paid through: 2026-02-15');
    expect(output).toContain(result.key);
    expect(output).toContain(`vibecarbon activate ${result.key}`);
  });

  it('mints and prints a -legacy (v1) key with Expires: Never', () => {
    const lines: string[] = [];
    const result = run(['-legacy', '-customer', 'cafebabe'], {
      privateKeyPem,
      log: (s) => lines.push(s),
    });

    expect(result.printed).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.format).toBe('v1');
    expect(result.validation.isLifetime).toBe(true);
    const output = lines.join('\n');
    expect(output).toContain('Tier:       Fullerene');
    expect(output).toContain('Expires:    Never');
    expect(output).not.toContain('Project:');
  });

  it('-legacy ignores -tier and always mints fullerene', () => {
    const result = run(['-legacy', '-tier', 'graphene', '-customer', 'cafebabe'], {
      privateKeyPem,
      log: () => {},
    });
    expect(result.validation.tier).toBe('fullerene');
  });

  it('requires -customer or -email', () => {
    expect(() => run(['-legacy'], { privateKeyPem, log: () => {} })).toThrow(
      /-customer.*or.*-email/i,
    );
  });

  it('requires VIBECARBON_LICENSE_PRIVATE_KEY (or an injected privateKeyPem)', () => {
    const originalEnv = process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
    delete process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
    try {
      expect(() => run(['-legacy', '-customer', 'cafebabe'], { log: () => {} })).toThrow(
        /VIBECARBON_LICENSE_PRIVATE_KEY/,
      );
    } finally {
      if (originalEnv !== undefined) process.env.VIBECARBON_LICENSE_PRIVATE_KEY = originalEnv;
    }
  });

  it('never prints a key that fails its own round-trip validation', async () => {
    vi.resetModules();
    vi.doMock('../../../src/lib/licensing/validator.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../../src/lib/licensing/validator.js')>();
      return { ...actual, validateLicenseKey: () => ({ valid: false, error: 'forced failure' }) };
    });

    const { run: runWithMockedValidator } = await import('../../../scripts/generate-license.js');
    const lines: string[] = [];
    expect(() =>
      runWithMockedValidator(['-legacy', '-customer', 'cafebabe'], {
        privateKeyPem,
        log: (s: string) => lines.push(s),
      }),
    ).toThrow(/Refusing to print/);
    expect(lines.join('\n')).not.toContain('License Key:');

    vi.doUnmock('../../../src/lib/licensing/validator.js');
    vi.resetModules();
  });
});

describe('emailToCustomerId', () => {
  it('is deterministic and case/whitespace-insensitive', () => {
    expect(emailToCustomerId('User@Acme.com')).toBe(emailToCustomerId(' user@acme.com '));
    expect(emailToCustomerId('user@acme.com')).toMatch(/^[a-f0-9]{8}$/);
  });
});
