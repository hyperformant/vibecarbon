/**
 * Change detection for secret values without hashing them.
 *
 * A step-skip gate needs "did this secret change since the last deploy" and
 * the answer is persisted (deploy-state-*.json). A plain sha256 of a secret
 * in a persisted file is an offline-guessable oracle for the value; a keyed
 * HMAC under a high-entropy key that never leaves this machine is not. The
 * key is 32 random bytes in ~/.vibecarbon/fingerprint.key (0600), minted on
 * first use. A different machine has a different key, so its first deploy
 * reads as "changed" and re-runs the step: the safe direction.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY_BYTES = 32;

function keyPath(dir) {
  return join(dir ?? join(homedir(), '.vibecarbon'), 'fingerprint.key');
}

/** The machine-local HMAC key (hex), minted once, never leaves this host. */
export function fingerprintKey({ dir } = {}) {
  const path = keyPath(dir);
  try {
    const existing = readFileSync(path, 'utf-8').trim();
    if (existing.length >= KEY_BYTES * 2) return existing;
  } catch {
    // fall through to mint
  }
  const key = randomBytes(KEY_BYTES).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 'wx': a concurrent deploy that minted first wins; read its key back.
    writeFileSync(path, `${key}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return key;
  } catch {
    try {
      return readFileSync(path, 'utf-8').trim();
    } catch {
      // Unwritable home: an in-process key still gives a stable-per-run, non-guessable value.
      return key;
    }
  }
}

/**
 * Start a keyed digest over secret material. `.update()` it, then
 * `.digest()`; the result is an HMAC-SHA256, never a plain hash.
 */
export function secretHmac(opts) {
  return createHmac('sha256', fingerprintKey(opts));
}

/** @returns {string} 16 hex chars of HMAC-SHA256(machine key, value) */
export function fingerprintSecret(value, opts) {
  return secretHmac(opts).update(String(value)).digest('hex').slice(0, 16);
}
