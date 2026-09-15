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
  parseArgs,
  run,
  signVerdictToken,
} from '../../../scripts/generate-license.js';
import { validateLicenseKey, verifyVerdictToken } from '../../../src/lib/licensing/validator.js';

function ephemeralPrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

describe('parseArgs', () => {
  it('accepts single-dash flags', () => {
    const opts = parseArgs(['-legacy', '-project', PROJECT_ID, '-customer', 'a1b2c3d4']);
    expect(opts.legacy).toBe(true);
    expect(opts.project).toBe(PROJECT_ID);
    expect(opts.customer).toBe('a1b2c3d4');
  });

  it('also accepts double-dash flags (back-compat with older docs/scripts)', () => {
    const opts = parseArgs(['--project', PROJECT_ID, '--email', 'user@acme.com']);
    expect(opts.project).toBe(PROJECT_ID);
    expect(opts.email).toBe('user@acme.com');
  });

  it('defaults to v2, no legacy', () => {
    const opts = parseArgs([]);
    expect(opts.legacy).toBe(false);
  });

  it('rejects the retired -tier/-paid-through/-months flags as unknown', () => {
    expect(() => parseArgs(['-tier', 'graphene'])).toThrow(/unknown flag/i);
    expect(() => parseArgs(['-paid-through', '2027-01-31'])).toThrow(/unknown flag/i);
    expect(() => parseArgs(['-months', '1'])).toThrow(/unknown flag/i);
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

  it('mintV2Key produces a 4-part key that validates as v2 with no tier or date', () => {
    const key = mintV2Key(privateKeyPem, { customerId: 'a1b2c3d4', projectId: PROJECT_ID });
    expect(key.split('-')).toHaveLength(4);
    const result = validateLicenseKey(key, { publicKeyPem });
    expect(result.valid).toBe(true);
    expect(result.format).toBe('v2');
    expect(result.tier).toBeNull();
    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.paidThrough).toBeNull();
    expect(result.isLifetime).toBe(false);
  });

  it('a v2 key does NOT validate against an unrelated public key', () => {
    const key = mintV2Key(privateKeyPem, { customerId: 'a1b2c3d4', projectId: PROJECT_ID });
    const otherPublicKeyPem = derivePublicKeyPem(ephemeralPrivateKeyPem());
    expect(validateLicenseKey(key, { publicKeyPem: otherPublicKeyPem }).valid).toBe(false);
  });

  it('signVerdictToken produces a token that verifies via verifyVerdictToken', () => {
    const fields = {
      projectId: PROJECT_ID,
      status: 'active',
      tier: 'graphene',
      periodEnd: '2026-09-30',
      issued: '2026-09-14',
    };
    const token = signVerdictToken(privateKeyPem, fields);
    expect(verifyVerdictToken(token, { publicKeyPem })).toEqual({ valid: true, ...fields });
  });
});

describe('run() end to end', () => {
  let privateKeyPem: string;

  beforeEach(() => {
    privateKeyPem = ephemeralPrivateKeyPem();
  });

  it('mints and prints a v2 key from -project and -email, with no paid-through', () => {
    const lines: string[] = [];
    const result = run(['-project', PROJECT_ID, '-email', 'a@b.co'], {
      privateKeyPem,
      log: (s) => lines.push(s),
    });

    expect(result.printed).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.format).toBe('v2');
    expect(result.validation.tier).toBeNull();
    const output = lines.join('\n');
    expect(output).toContain(`Project:    ${PROJECT_ID}`);
    expect(output).not.toContain('Paid through:');
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

  it('rejects the retired -paid-through and -tier flags as unknown', () => {
    expect(() =>
      run(['-paid-through', '2027-01-31', '-legacy', '-customer', 'cafebabe'], {
        privateKeyPem,
        log: () => {},
      }),
    ).toThrow(/unknown flag/i);
    expect(() =>
      run(['-tier', 'graphene', '-legacy', '-customer', 'cafebabe'], {
        privateKeyPem,
        log: () => {},
      }),
    ).toThrow(/unknown flag/i);
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
