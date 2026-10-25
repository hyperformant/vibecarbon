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
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY_BYTES = 32;
const KEY_HEX = /^[0-9a-f]{64}$/;

// Per-directory, so one process keeps one key even if the home is unwritable.
const cache = new Map();

function keyDir(dir) {
  return dir ?? process.env.VIBECARBON_FINGERPRINT_KEY_DIR ?? join(homedir(), '.vibecarbon');
}

/** The file's key if it is exactly 32 bytes of hex, else null. Tightens loose modes. */
function readKey(path) {
  let text;
  try {
    text = readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
  if (!KEY_HEX.test(text)) return null;
  try {
    if (statSync(path).mode & 0o077) {
      chmodSync(path, 0o600);
      console.error(`[fingerprint] ${path} was group/world-readable; tightened to 0600`);
    }
  } catch {
    // best effort: the key itself is valid
  }
  return text;
}

/** Block ~50ms: lets a racing writer finish its write. */
function pause() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

/**
 * The machine-local HMAC key (64 hex chars = 32 bytes), minted once, never
 * leaves this host. Never returns a short or empty key: a file that is not
 * exactly 32 bytes (a racing writer mid-write, corruption) is re-read once
 * after a short wait, then refused.
 */
export function fingerprintKey({ dir } = {}) {
  const base = keyDir(dir);
  const cached = cache.get(base);
  if (cached) return cached;
  const path = join(base, 'fingerprint.key');
  const remember = (k) => {
    cache.set(base, k);
    return k;
  };

  const existing = readKey(path);
  if (existing) return remember(existing);

  const key = randomBytes(KEY_BYTES).toString('hex');
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 'wx': a concurrent deploy that minted first wins; read its key back.
    writeFileSync(path, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return remember(key);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      let theirs = readKey(path);
      if (!theirs) {
        pause();
        theirs = readKey(path);
      }
      if (theirs) return remember(theirs);
      throw new Error(
        `${path} exists but does not hold a 32-byte key (corrupt or half-written); delete it and re-run.`,
      );
    }
    // Unwritable home: an in-process key is stable for this run and unguessable.
    return remember(key);
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

/** Test seam: forget cached keys. */
export function resetFingerprintKeyCache() {
  cache.clear();
}
