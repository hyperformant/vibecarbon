/**
 * scripts/generate-license.js: the operator-facing minting script for the
 * project-less key. Exercised in-process (importing the script's exported
 * helpers against an ephemeral keypair) rather than by spawning a process -
 * cheap and the script is importable specifically for this.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  derivePublicKeyPem,
  mintKey,
  parseArgs,
  randomLicenseId,
  run,
  signVerdictToken,
} from '../../../scripts/generate-license.js';
import { validateLicenseKey, verifyVerdictToken } from '../../../src/lib/licensing/validator.js';

const { privateKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = derivePublicKeyPem(PEM);

describe('generate-license', () => {
  it('randomLicenseId is 16 hex', () => {
    expect(randomLicenseId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('mintKey produces a key the CLI validator accepts', () => {
    const key = mintKey(PEM, { licenseId: '0123456789abcdef' });
    expect(key).toMatch(/^vc-0123456789abcdef-[0-9a-f]{128}$/);
    expect(validateLicenseKey(key, { publicKeyPem: PUB })).toEqual({
      valid: true,
      verified: true,
      licenseId: '0123456789abcdef',
    });
  });

  it('mintKey refuses a bad licenseId', () => {
    expect(() => mintKey(PEM, { licenseId: 'nope' })).toThrow(/licenseId/);
  });

  it('parseArgs reads --license-id / -license-id and -h', () => {
    expect(parseArgs(['--license-id', '0123456789abcdef'])).toEqual({
      help: false,
      licenseId: '0123456789abcdef',
    });
    expect(parseArgs(['-license-id', '0123456789abcdef'])).toEqual({
      help: false,
      licenseId: '0123456789abcdef',
    });
    expect(parseArgs(['-h']).help).toBe(true);
    expect(() => parseArgs(['-legacy'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['-email', 'x@y'])).toThrow(/Unknown option/);
  });

  it('run mints a random id when none is given and prints the activate line', () => {
    const lines: string[] = [];
    const out = run([], { privateKeyPem: PEM, log: (l: string) => lines.push(l) });
    expect(out.printed).toBe(true);
    expect(out.key).toMatch(/^vc-[0-9a-f]{16}-[0-9a-f]{128}$/);
    expect(lines.join('\n')).toContain(`vibecarbon activate ${out.key}`);
    expect(lines.join('\n')).toContain(`License ID: ${out.validation.licenseId}`);
  });

  it('run requires the private key', () => {
    const saved = process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
    delete process.env.VIBECARBON_LICENSE_PRIVATE_KEY;
    expect(() => run([])).toThrow(/VIBECARBON_LICENSE_PRIVATE_KEY/);
    if (saved) process.env.VIBECARBON_LICENSE_PRIVATE_KEY = saved;
  });

  it('signVerdictToken still signs unbound / wrong_project verdicts', () => {
    const pid = '11111111-1111-4111-8111-111111111111';
    const t = signVerdictToken(PEM, {
      projectId: pid,
      status: 'unbound',
      tier: 'none',
      periodEnd: '2026-09-15',
      issued: '2026-09-15',
    });
    expect(verifyVerdictToken(t, { publicKeyPem: PUB })).toMatchObject({
      valid: true,
      status: 'unbound',
      projectId: pid,
    });
  });
});
