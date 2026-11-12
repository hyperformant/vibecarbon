/**
 * The per-project Pulumi state passphrase: generate it once, keep it only in
 * `.env.local`, and record a fingerprint of it in `.vibecarbon.json` so a
 * wrong or missing copy is caught before Pulumi touches the state.
 *
 * - The passphrase lives in `VIBECARBON_STATE_PASSPHRASE` (an operator secret:
 *   `.env.local` only, never `.env`, never bundled, never on a server).
 * - The fingerprint (`stateEncryption.fingerprint`) is committed; it cannot
 *   be reversed into the passphrase, and it is a slow hash (scrypt), so
 *   guessing a passphrase from it costs a guesser scrypt's work per guess.
 *   No error, log line or telemetry field carries it.
 *
 * `resolveStatePassphrase()` is the sync, environment-only read.
 * `ensureStatePassphrase(projectDir)` is the full check-or-create.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { readProjectConfigFile, updateProjectConfig } from './config.js';
import { readProjectConfigAtHead } from './git-head.js';
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

/**
 * @typedef {object} StatePassphraseProvenance
 * @property {boolean} madeHere this clone most likely made the passphrase: a
 *   state Pulumi refuses with it may be one a teammate's passphrase reads
 * @property {boolean} thisRun this process made it (statePassphraseGeneratedThisRun)
 * @property {'committed' | 'uncommitted' | 'unknown' | 'no-git'} head what
 *   git's HEAD says about the fingerprint .vibecarbon.json records:
 *   committed (HEAD's copy records the same one), uncommitted (HEAD lacks
 *   the file or its `stateEncryption`, or records another), unknown (git
 *   failed some other way, or HEAD's copy doesn't parse), no-git (not a git
 *   checkout, or git isn't installed)
 * @property {true} [untracked] set only for an uncommitted fingerprint whose
 *   .vibecarbon.json no commit at HEAD holds at all: .gitignore lists it, or
 *   it was never added (the hint says to commit the file the team relies on)
 * @property {string} [detail] git's own line, for `unknown`
 */

/**
 * Was this project's passphrase made in this clone, across processes? Destroy
 * asks once Pulumi has refused it on a stack: a passphrase made here (an
 * `upgrade` or deploy on a clone that hadn't pulled a teammate's
 * .vibecarbon.json) says nothing about whether the team's passphrase reads
 * the state, so that record must stay.
 *
 * In a git checkout the signal lasts: a fingerprint HEAD doesn't record was
 * made in this clone and not yet committed as the project's, whichever run
 * made it, and a git failure that can't tell counts the same way (keep).
 * Outside a git checkout, or without git, nothing lasts from one run to the
 * next, so only this process making it counts (the rule before git was
 * asked). Spawns git, so it is for that rare path only.
 *
 * @param {string} projectDir
 * @returns {StatePassphraseProvenance}
 */
export function statePassphraseProvenance(projectDir) {
  const dir = resolve(projectDir);
  const thisRun = generatedHere.has(dir);
  const recorded = recordedFingerprint(dir);
  const read = readProjectConfigAtHead(dir);
  /** @type {StatePassphraseProvenance['head']} */
  let head;
  let detail;
  let untracked = false;
  if (read.state === 'no-git') head = 'no-git';
  else if (read.state === 'absent') {
    head = 'uncommitted';
    untracked = true;
  } else if (read.state === 'unknown') {
    head = 'unknown';
    detail = read.detail;
  } else {
    let committed;
    try {
      committed = JSON.parse(read.content)?.stateEncryption?.fingerprint ?? null;
    } catch {
      head = 'unknown';
      detail = "the .vibecarbon.json committed at HEAD isn't valid JSON";
    }
    head ??= recorded && committed === recorded ? 'committed' : 'uncommitted';
  }
  const madeHere = thisRun || head === 'uncommitted' || head === 'unknown';
  return {
    madeHere,
    thisRun,
    head,
    ...(untracked && { untracked: true }),
    ...(detail !== undefined && { detail }),
  };
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
 * The fingerprint's KDF. The salt is fixed and versioned, not random: every
 * clone must derive the same fingerprint from the same passphrase to compare
 * it with the committed one, and the domain string keeps it from matching any
 * other scrypt use. N = 2^15, r = 8, p = 1 takes 32 MiB and about 45 ms
 * per call (up to about 110 ms on a cold CPU) on a Ryzen AI 9 365 laptop;
 * maxmem leaves room above the 32 MiB Node allows by default. A change to any of these is a new fingerprint
 * format: bump the version in the salt and the prefix together.
 */
const FINGERPRINT_PREFIX = 'scrypt:';
const FINGERPRINT_SALT = 'vibecarbon-state-passphrase-fingerprint-v1';
const FINGERPRINT_SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
/** Bytes of the derived key kept: 64 bits, as hex. */
const FINGERPRINT_BYTES = 8;

/**
 * Fingerprints this process derived, by passphrase: one command compares the
 * same value more than once (the first look, case 2's re-check, destroy's
 * problem check), and each derivation costs scrypt's work. The passphrases
 * are the ones this process already holds in process.env.
 * @type {Map<string, string>}
 */
const fingerprints = new Map();

/**
 * `scrypt:` plus 16 hex chars of the passphrase's scrypt key under the
 * domain salt. Stable across clones and processes.
 * @param {string} passphrase
 */
export function statePassphraseFingerprint(passphrase) {
  const known = fingerprints.get(passphrase);
  if (known) return known;
  const key = scryptSync(passphrase, FINGERPRINT_SALT, FINGERPRINT_BYTES, FINGERPRINT_SCRYPT);
  const fingerprint = `${FINGERPRINT_PREFIX}${key.toString('hex')}`;
  fingerprints.set(passphrase, fingerprint);
  return fingerprint;
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

/**
 * The errors below name no fingerprint, the recorded one or the value's: an
 * error's message reaches crash telemetry (telemetry/sanitize.js), and a
 * fingerprint is derived from a passphrase.
 */
function missingError() {
  return new StatePassphraseError(
    'missing',
    `This project's state passphrase isn't set. vibecarbon needs ${STATE_PASSPHRASE_KEY} to read your Pulumi state (.vibecarbon.json records the fingerprint of the one this project uses). Copy it into .env.local from where you saved it (a teammate who deployed this project has it too), then run this again. If it's lost for good, first run \`vibecarbon backup\` for each environment you deployed with it, to keep a copy of its database. Then delete the \`stateEncryption\` entry from .vibecarbon.json; vibecarbon makes a new passphrase the next time it needs one. Run \`vibecarbon destroy\` (once more if it asks) and deploy again for each of those environments: their state can't be read any more, so destroy removes the record.`,
  );
}

/** @param {{ source: 'shell' | 'env-local', where: string }} from */
function mismatchError(from) {
  const wins = from.source === 'shell' ? ', which wins over .env.local' : '';
  return new StatePassphraseError(
    'mismatch',
    `Your ${STATE_PASSPHRASE_KEY} (from ${from.where}${wins}) doesn't match the fingerprint .vibecarbon.json records for this project. Fix the value, then run this again.`,
    from.source,
  );
}

/**
 * What case 2 says once it recorded a value's fingerprint: commit it, and,
 * when .env.local (read trimmed and unquoted, as the look reads it) doesn't
 * hold the value, that the shell is the only place it lives. A later shell
 * without the export would otherwise meet the 'missing' error for a value
 * nobody saved for this project. Never the value itself.
 * @param {string} dir
 * @param {string} value
 */
function recordedLine(dir, value) {
  const stored = readOperatorVar(STATE_PASSPHRASE_KEY, {
    env: { [STATE_PASSPHRASE_KEY]: loadEnvVariables(dir)[STATE_PASSPHRASE_KEY] },
  }).value;
  const line = "Recorded your state passphrase's fingerprint in .vibecarbon.json. Commit it.";
  return stored === value
    ? line
    : `${line} The passphrase itself is only in your shell: add it to .env.local too.`;
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
    return { value: null, fromDisk, problem: expected ? missingError() : null };
  }
  if (found.problem) return { value: null, fromDisk, problem: invalidError(sourceOf(read)) };
  const actual = statePassphraseFingerprint(found.value);
  if (expected && actual !== expected) {
    return { value: null, fromDisk, problem: mismatchError(sourceOf(read)) };
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
    if (!expected) {
      // Case 2: an existing value (copied in from a password manager, or
      // exported in the shell) and no fingerprint yet.
      const actual = statePassphraseFingerprint(value);
      let recorded = false;
      updateProjectConfig((manifest) => {
        if (manifest.stateEncryption?.fingerprint) return;
        manifest.stateEncryption = { ...manifest.stateEncryption, fingerprint: actual };
        recorded = true;
      }, dir);
      // The lock may have found another process's fingerprint, recorded
      // since the look above. Then that value is the project's, not this
      // one: using this one would re-encrypt legacy stacks under a
      // passphrase the record doesn't hold.
      const now = recordedFingerprint(dir);
      if (now !== actual) {
        throw mismatchError(sourceOf(fromDisk ? 'disk' : 'environment'));
      }
      if (recorded) p.log.info(recordedLine(dir, value));
    }
    // Read from .env.local just now: later Pulumi calls in this process read
    // the environment.
    if (fromDisk) process.env[STATE_PASSPHRASE_KEY] = value;
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
    // Never overwrite a stored passphrase (a writer that landed after the
    // look above can reach here): record nothing and let the re-check below
    // adopt it, shape check and fingerprint included. Read the way that look
    // does, trimmed and unquoted, so a value of only spaces is not "stored".
    const stored = readOperatorVar(STATE_PASSPHRASE_KEY, {
      env: { [STATE_PASSPHRASE_KEY]: loadEnvVariables(dir)[STATE_PASSPHRASE_KEY] },
    }).value;
    if (stored) return;
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
