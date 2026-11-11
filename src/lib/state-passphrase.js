/**
 * The per-project Pulumi state passphrase: generate it once, keep it only in
 * `.env.local`, and record a fingerprint of it in `.vibecarbon.json` so a
 * wrong or missing copy is caught before Pulumi touches the state.
 *
 * - The passphrase lives in `VIBECARBON_STATE_PASSPHRASE` (an operator secret:
 *   `.env.local` only, never `.env`, never bundled, never on a server).
 * - The fingerprint (`stateEncryption.fingerprint`) is committed; it cannot
 *   be reversed into the passphrase.
 *
 * `resolveStatePassphrase()` is the sync, environment-only read.
 * `ensureStatePassphrase(projectDir)` is the full check-or-create.
 */

import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { readProjectConfigFile, updateProjectConfig } from './config.js';
import { readOperatorVar } from './operator-env.js';
import { describeCredentialSource, loadEnvVariables, setEnvVar } from './project.js';

export const STATE_PASSPHRASE_KEY = 'VIBECARBON_STATE_PASSPHRASE';

/** Per-process memo of verified passphrases, keyed by absolute project dir. */
const verified = new Map();

/** Test-only: forget which projects were already verified this process. */
export function __resetStatePassphraseForTests() {
  verified.clear();
}

export class StatePassphraseError extends Error {
  /** @param {'missing' | 'mismatch' | 'invalid'} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.name = 'StatePassphraseError';
    this.reason = reason;
  }
}

/** A new random passphrase (256 bits, URL-safe). */
export function generateStatePassphrase() {
  return randomBytes(32).toString('base64url');
}

/**
 * `sha256:` plus 16 hex chars of a domain-separated hash of the passphrase.
 * @param {string} passphrase
 */
export function statePassphraseFingerprint(passphrase) {
  const hex = createHash('sha256')
    .update(`vibecarbon-state-passphrase\0${passphrase}`)
    .digest('hex');
  return `sha256:${hex.slice(0, 16)}`;
}

/**
 * The passphrase from the environment (shell wins over .env.local), or null.
 * @throws {StatePassphraseError} 'invalid' when the value fails the registry's
 *   shape (too short or outside base64url): it is refused before anything
 *   uses or fingerprints it. The message never echoes the value.
 */
export function resolveStatePassphrase() {
  const { value, problem } = readOperatorVar(STATE_PASSPHRASE_KEY);
  if (value && problem) {
    const source = describeCredentialSource([STATE_PASSPHRASE_KEY]);
    throw new StatePassphraseError(
      'invalid',
      `Your ${STATE_PASSPHRASE_KEY} (from ${source.where}) is too weak to protect your Pulumi state: it needs at least 43 letters, digits, dashes or underscores. Use the value vibecarbon generated for this project. If this project has no deployed state yet, delete the line and run this again to make a new one.`,
    );
  }
  return value;
}

function recordedFingerprint(dir) {
  return readProjectConfigFile(dir)?.stateEncryption?.fingerprint ?? null;
}

/** @param {string} expected the recorded fingerprint */
function missingError(expected) {
  return new StatePassphraseError(
    'missing',
    `This project's state passphrase isn't set. vibecarbon needs ${STATE_PASSPHRASE_KEY} to read your Pulumi state (.vibecarbon.json expects fingerprint ${expected}). Copy it into .env.local from where you saved it, then run this again.`,
  );
}

/**
 * @param {string} expected the recorded fingerprint
 * @param {string} actual the value's fingerprint
 */
function mismatchError(expected, actual) {
  const source = describeCredentialSource([STATE_PASSPHRASE_KEY]);
  const wins = source.source === 'shell' ? ', which wins over .env.local' : '';
  return new StatePassphraseError(
    'mismatch',
    `Your ${STATE_PASSPHRASE_KEY} (from ${source.where}${wins}) doesn't match this project. .vibecarbon.json expects ${expected} and yours is ${actual}. Fix the value, then run this again.`,
  );
}

/**
 * What is wrong with this project's passphrase, without fixing anything: the
 * StatePassphraseError ensureStatePassphrase would throw, returned instead of
 * thrown, or null when the value matches the recorded fingerprint or nothing
 * is recorded yet (a project the next stack-opening command sets up).
 *
 * Read-only: it generates nothing, records nothing and leaves process.env
 * alone, reading `.env.local` directly the way ensureStatePassphrase's own
 * second look does. For `destroy`, which can tear down without the
 * passphrase and only needs to say why it is going around the state.
 *
 * @param {string} projectDir
 * @returns {StatePassphraseError | null}
 */
export function findStatePassphraseProblem(projectDir) {
  const dir = resolve(projectDir);
  let value;
  try {
    value = resolveStatePassphrase();
  } catch (err) {
    if (err instanceof StatePassphraseError) return err;
    throw err;
  }
  const expected = recordedFingerprint(dir);
  if (!expected) return null;
  const candidate = value || loadEnvVariables(dir)[STATE_PASSPHRASE_KEY];
  if (!candidate) return missingError(expected);
  const actual = statePassphraseFingerprint(candidate);
  return actual === expected ? null : mismatchError(expected, actual);
}

/**
 * Check the project's passphrase against its recorded fingerprint, creating
 * both on a project that has neither. Memoized per process per project.
 *
 * @param {string} projectDir
 * @returns {Promise<string>} the passphrase
 * @throws {StatePassphraseError} 'missing' or 'mismatch'
 */
export async function ensureStatePassphrase(projectDir) {
  const dir = resolve(projectDir);
  if (verified.has(dir)) return verified.get(dir);

  const value = resolveStatePassphrase();
  const expected = recordedFingerprint(dir);

  if (value) {
    const actual = statePassphraseFingerprint(value);
    if (expected && expected !== actual) throw mismatchError(expected, actual);
    if (!expected) {
      // Case 2: an existing value (e.g. copied in from a password manager).
      updateProjectConfig((manifest) => {
        if (manifest.stateEncryption?.fingerprint) return;
        manifest.stateEncryption = { ...manifest.stateEncryption, fingerprint: actual };
      }, dir);
    }
    verified.set(dir, value);
    return value;
  }

  if (expected) {
    // The CLI folds .env.local into the environment once at startup. A
    // process that started while another was still generating can have
    // missed the file, so look at it once more before calling it missing.
    const onDisk = loadEnvVariables(dir)[STATE_PASSPHRASE_KEY];
    if (onDisk) {
      process.env[STATE_PASSPHRASE_KEY] = onDisk;
      return ensureStatePassphrase(dir);
    }
    throw missingError(expected);
  }

  // Neither exists: make both, all under the config lock (the mutator is
  // synchronous). Whoever holds the lock first writes the value and the
  // fingerprint together; a later arrival sees the fingerprint and adopts the
  // winner's value from .env.local, so concurrent ensures end with ONE value.
  const fresh = generateStatePassphrase();
  let generated = false;
  updateProjectConfig((manifest) => {
    if (manifest.stateEncryption?.fingerprint) return;
    // SECURITY: .env.local only (localOnly), never .env, which ships to servers.
    setEnvVar(STATE_PASSPHRASE_KEY, fresh, dir, { localOnly: true });
    manifest.stateEncryption = {
      ...manifest.stateEncryption,
      fingerprint: statePassphraseFingerprint(fresh),
    };
    generated = true;
  }, dir);

  if (!generated) {
    const theirs = loadEnvVariables(dir)[STATE_PASSPHRASE_KEY];
    if (theirs) process.env[STATE_PASSPHRASE_KEY] = theirs;
    return ensureStatePassphrase(dir);
  }

  process.env[STATE_PASSPHRASE_KEY] = fresh;
  p.log.info(
    `Made a state passphrase for this project and saved it to .env.local as ${STATE_PASSPHRASE_KEY}. Commit .vibecarbon.json (it records only the passphrase's fingerprint) and keep a copy of the passphrase in your password manager.`,
  );
  verified.set(dir, fresh);
  return fresh;
}
