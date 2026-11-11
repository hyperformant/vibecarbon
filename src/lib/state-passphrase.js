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

/** Project dirs whose passphrase this process generated (case 5). */
const generatedHere = new Set();

/** Test-only: forget which projects were already verified this process. */
export function __resetStatePassphraseForTests() {
  verified.clear();
  generatedHere.clear();
}

/**
 * Whether this process generated the project's passphrase: it found neither
 * a value nor a recorded fingerprint, and made both. A state Pulumi then
 * refuses was written by a passphrase this clone never had (a teammate's,
 * from a .vibecarbon.json not yet pulled), not by one that is lost, which
 * is why destroy keeps that stack's record.
 * @param {string} projectDir
 * @returns {boolean}
 */
export function statePassphraseGeneratedThisRun(projectDir) {
  return generatedHere.has(resolve(projectDir));
}

export class StatePassphraseError extends Error {
  /**
   * @param {'missing' | 'mismatch' | 'invalid'} reason
   * @param {string} message
   * @param {'shell' | 'env-local'} [source] where the refused value came from
   *   (none for 'missing'), so a caller can say which store to fix
   */
  constructor(reason, message, source) {
    super(message);
    this.name = 'StatePassphraseError';
    this.reason = reason;
    this.source = source;
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
  if (value && problem) throw invalidError(sourceOf('environment'));
  return value;
}

function recordedFingerprint(dir) {
  return readProjectConfigFile(dir)?.stateEncryption?.fingerprint ?? null;
}

/**
 * Where a value came from. One already in process.env is the shell's unless
 * the CLI loaded it from .env.local at startup (describeCredentialSource); one
 * read from the file just now is .env.local's, whatever that function says.
 * @param {'environment' | 'disk'} read
 * @returns {{ source: 'shell' | 'env-local', where: string }}
 */
function sourceOf(read) {
  if (read === 'disk') return { source: 'env-local', where: "your project's .env.local" };
  const { source, where } = describeCredentialSource([STATE_PASSPHRASE_KEY]);
  return { source, where };
}

/** @param {{ source: 'shell' | 'env-local', where: string }} from */
function invalidError(from) {
  return new StatePassphraseError(
    'invalid',
    `Your ${STATE_PASSPHRASE_KEY} (from ${from.where}) is too weak to protect your Pulumi state: it needs at least 43 letters, digits, dashes or underscores. Use the value vibecarbon generated for this project. If this project has no deployed state yet, delete the line and run this again to make a new one.`,
    from.source,
  );
}

/** @param {string} expected the recorded fingerprint */
function missingError(expected) {
  return new StatePassphraseError(
    'missing',
    `This project's state passphrase isn't set. vibecarbon needs ${STATE_PASSPHRASE_KEY} to read your Pulumi state (.vibecarbon.json expects fingerprint ${expected}). Copy it into .env.local from where you saved it, then run this again. If it's lost for good, delete the \`stateEncryption\` entry from .vibecarbon.json and vibecarbon makes a new passphrase the next time it needs one. Then run \`vibecarbon destroy\` (once more if it asks) and deploy again for each environment you deployed with the old one: its state can't be read any more, so destroy removes the record.`,
  );
}

/**
 * @param {string} expected the recorded fingerprint
 * @param {string} actual the value's fingerprint
 * @param {{ source: 'shell' | 'env-local', where: string }} from
 */
function mismatchError(expected, actual, from) {
  const wins = from.source === 'shell' ? ', which wins over .env.local' : '';
  return new StatePassphraseError(
    'mismatch',
    `Your ${STATE_PASSPHRASE_KEY} (from ${from.where}${wins}) doesn't match this project. .vibecarbon.json expects ${expected} and yours is ${actual}. Fix the value, then run this again.`,
    from.source,
  );
}

/**
 * The passphrase this project would use and what is wrong with it, changing
 * nothing. The one verdict both ensureStatePassphrase and
 * findStatePassphraseProblem act on, so they cannot disagree.
 *
 * A value in the environment wins; an empty one counts as unset. Without
 * one, `.env.local` is read from disk: the CLI folds it into the environment
 * once at startup, and a process that started while another was still
 * generating, or with an empty export in the shell, can have missed the file. Either value gets the same
 * shape check before its fingerprint is compared.
 *
 * @param {string} dir absolute project dir
 * @param {string | null} expected the recorded fingerprint
 * @returns {{ value: string | null, fromDisk: boolean, problem: StatePassphraseError | null }}
 */
function inspectStatePassphrase(dir, expected) {
  let read = 'environment';
  let found = readOperatorVar(STATE_PASSPHRASE_KEY);
  // An empty export counts as unset (readOperatorVar yields no value for it),
  // so .env.local is read whether or not a fingerprint is recorded: a stored
  // passphrase must never be passed over for a new one.
  if (!found.value) {
    read = 'disk';
    found = readOperatorVar(STATE_PASSPHRASE_KEY, {
      env: { [STATE_PASSPHRASE_KEY]: loadEnvVariables(dir)[STATE_PASSPHRASE_KEY] },
    });
  }
  const fromDisk = read === 'disk';
  if (!found.value) {
    return { value: null, fromDisk, problem: expected ? missingError(expected) : null };
  }
  if (found.problem) return { value: null, fromDisk, problem: invalidError(sourceOf(read)) };
  const actual = statePassphraseFingerprint(found.value);
  if (expected && actual !== expected) {
    return { value: null, fromDisk, problem: mismatchError(expected, actual, sourceOf(read)) };
  }
  return { value: found.value, fromDisk, problem: null };
}

/**
 * What is wrong with this project's passphrase, without fixing anything: the
 * StatePassphraseError ensureStatePassphrase would throw, returned instead of
 * thrown, or null when the value matches the recorded fingerprint or nothing
 * is recorded yet (a project the next stack-opening command sets up).
 *
 * Read-only: it generates nothing, records nothing and leaves process.env
 * alone. For `destroy`, which can tear down without the passphrase and only
 * needs to say why it is going around the state.
 *
 * @param {string} projectDir
 * @returns {StatePassphraseError | null}
 */
export function findStatePassphraseProblem(projectDir) {
  const dir = resolve(projectDir);
  return inspectStatePassphrase(dir, recordedFingerprint(dir)).problem;
}

/**
 * Check the project's passphrase against its recorded fingerprint, creating
 * both on a project that has neither. Memoized per process per project.
 *
 * @param {string} projectDir
 * @returns {Promise<string>} the passphrase
 * @throws {StatePassphraseError} 'missing', 'mismatch' or 'invalid'
 */
export async function ensureStatePassphrase(projectDir) {
  const dir = resolve(projectDir);
  if (verified.has(dir)) return verified.get(dir);

  const expected = recordedFingerprint(dir);
  const { value, fromDisk, problem } = inspectStatePassphrase(dir, expected);
  if (problem) throw problem;

  if (value) {
    // Read from .env.local just now: later Pulumi calls in this process read
    // the environment.
    if (fromDisk) process.env[STATE_PASSPHRASE_KEY] = value;
    if (!expected) {
      // Case 2: an existing value (e.g. copied in from a password manager).
      const actual = statePassphraseFingerprint(value);
      updateProjectConfig((manifest) => {
        if (manifest.stateEncryption?.fingerprint) return;
        manifest.stateEncryption = { ...manifest.stateEncryption, fingerprint: actual };
      }, dir);
    }
    verified.set(dir, value);
    return value;
  }

  // Neither exists: make both, all under the config lock (the mutator is
  // synchronous). Whoever holds the lock first writes the value and the
  // fingerprint together; a later arrival sees the fingerprint and adopts the
  // winner's value from .env.local, so concurrent ensures end with ONE value.
  const fresh = generateStatePassphrase();
  let generated = false;
  updateProjectConfig((manifest) => {
    if (manifest.stateEncryption?.fingerprint) return;
    // Never overwrite a stored passphrase (a process that missed it, or an
    // empty shell export, can reach here): record its fingerprint and let the
    // re-check below adopt it.
    const stored = loadEnvVariables(dir)[STATE_PASSPHRASE_KEY];
    if (stored) {
      manifest.stateEncryption = {
        ...manifest.stateEncryption,
        fingerprint: statePassphraseFingerprint(stored),
      };
      return;
    }
    // SECURITY: .env.local only (localOnly), never .env, which ships to servers.
    setEnvVar(STATE_PASSPHRASE_KEY, fresh, dir, { localOnly: true });
    manifest.stateEncryption = {
      ...manifest.stateEncryption,
      fingerprint: statePassphraseFingerprint(fresh),
    };
    generated = true;
  }, dir);

  // Lost the race: the winner's fingerprint is recorded and its value is in
  // .env.local, which the next look reads from disk.
  if (!generated) return ensureStatePassphrase(dir);

  process.env[STATE_PASSPHRASE_KEY] = fresh;
  generatedHere.add(dir);
  p.log.info(
    `Made a state passphrase for this project and saved it to .env.local as ${STATE_PASSPHRASE_KEY}. Commit .vibecarbon.json (it records only the passphrase's fingerprint) and keep a copy of the passphrase in your password manager.`,
  );
  verified.set(dir, fresh);
  return fresh;
}
