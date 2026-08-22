import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePassword } from '../../../src/lib/secrets.js';
import { healShortVaultEncKey } from '../../../src/upgrade.js';

/**
 * VAULT_ENC_KEY must be exactly 32 BYTES: Supavisor's tenant seed encrypts
 * the pooler manager password with Cloak AES-256-GCM, and Erlang :crypto
 * hard-rejects any other key size — the container crash-loops with
 * "Unknown cipher or invalid key size" (RCA: kept compose rig e1,
 * 2026-08-06; latent for months because nothing exercised the encryption
 * until the tenant seed existed).
 */

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf-8');

describe('VAULT_ENC_KEY is 32 bytes', () => {
  it('generatePassword(32) emits exactly 32 single-byte chars', () => {
    const key = generatePassword(32);
    expect(key.length).toBe(32);
    expect(Buffer.byteLength(key)).toBe(32);
  });

  it('create generates the vault key at 32 chars (never 16 again)', () => {
    const src = read('src/create.js');
    expect(src).toMatch(/vaultEncKey = generatePassword\(32\)/);
  });

  // The assertion that used to live here matched SOURCE TEXT with a regex:
  //   /VAULT_ENC_KEY[\s\S]{0,220}length >= 32[\s\S]{0,80}generatePassword\(32\)/
  // It passed for months against code that healed NOTHING. The heal computed a
  // fresh key inside reconstructVariables, whose only consumer (resolveTemplate)
  // skips every SECRET_PLACEHOLDERS key — VAULT_ENC_KEY among them — and nothing
  // in upgrade.js wrote .env.local at all. The new key was generated, never
  // substituted, never persisted, discarded. Only fresh `create`s were fixed.
  //
  // Replaced with a BEHAVIORAL test against a real temp project: run the heal,
  // then read the file back. A regex cannot tell "computes a value" from
  // "persists a value", which is exactly the distinction that mattered.
  describe('upgrade heals short pre-2026-08 keys — verified by reading the file back', () => {
    const project = (vaultLine: string | null) => {
      const dir = mkdtempSync(join(tmpdir(), 'vc-vault-heal-'));
      writeFileSync(
        join(dir, '.env.local'),
        ['PROJECT_NAME=demo', ...(vaultLine ? [vaultLine] : [])].join('\n') + '\n',
      );
      return dir;
    };
    const vaultKeyIn = (dir: string) =>
      (
        readFileSync(join(dir, '.env.local'), 'utf-8').match(/^VAULT_ENC_KEY=(.*)$/m)?.[1] ?? ''
      ).replace(/^['"]|['"]$/g, '');

    it('rewrites a 16-char key to 32 and PERSISTS it', () => {
      const dir = project("VAULT_ENC_KEY='0123456789abcdef'");
      expect(healShortVaultEncKey(dir)).toBe(true);
      const healed = vaultKeyIn(dir);
      expect(healed.length).toBe(32);
      expect(healed).not.toBe('0123456789abcdef');
    });

    it('leaves an already-32-byte key untouched (no gratuitous rotation)', () => {
      const existing = 'a'.repeat(32);
      const dir = project(`VAULT_ENC_KEY='${existing}'`);
      expect(healShortVaultEncKey(dir)).toBe(false);
      expect(vaultKeyIn(dir)).toBe(existing);
    });

    it('writes one when the key is missing entirely', () => {
      const dir = project(null);
      expect(healShortVaultEncKey(dir)).toBe(true);
      expect(vaultKeyIn(dir).length).toBe(32);
    });
  });
});
