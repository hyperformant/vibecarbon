/**
 * `.vibecarbon.json` as the project's git checkout last committed it, for
 * the one question only git can answer across processes: did this clone
 * make what its working copy records, or did it come with the commit?
 *
 * One `git show HEAD:./.vibecarbon.json` (CONFIG_FILE), with fixed arguments
 * only (nothing from the user reaches argv; the project dir is the child's
 * cwd) and git's repo context scrubbed (gitSafeEnv: an inherited GIT_DIR
 * would answer for another repo). LC_ALL=C keeps git's messages in English,
 * which is how its "not a git repository" is told apart from a file HEAD
 * lacks. Bounded, and read only on the rare path that asks (a destroy whose
 * state the project passphrase cannot read).
 */

import { spawnSync } from 'node:child_process';
import { gitSafeEnv } from './command.js';
import { CONFIG_FILE } from './config.js';

/** How long one `git show` may take before its answer counts as unknown. */
const GIT_SHOW_TIMEOUT_MS = 10_000;

/** git's answer when the dir is in no work tree at all. */
const NOT_A_CHECKOUT = /not a git repository/i;

/**
 * git's answers when the checkout has no committed copy of the file: never
 * added (`exists on disk, but not in 'HEAD'`), deleted (`does not exist in
 * 'HEAD'`), or no commit yet (`invalid object name 'HEAD'`).
 */
const NOT_AT_HEAD =
  /exists on disk, but not in 'HEAD'|does not exist in 'HEAD'|invalid object name 'HEAD'/i;

/**
 * @typedef {{ state: 'committed', content: string }
 *   | { state: 'absent' }
 *   | { state: 'no-git' }
 *   | { state: 'unknown', detail: string }} HeadRead
 *   - committed: HEAD holds the file; `content` is that copy.
 *   - absent: a git checkout whose HEAD lacks the file (or has no commit).
 *   - no-git: not a git checkout, or git isn't installed.
 *   - unknown: git ran and failed some other way (dubious ownership, a
 *     timeout, a corrupt repo); `detail` is its first line.
 */

/**
 * @param {string} projectDir
 * @returns {HeadRead}
 */
export function readProjectConfigAtHead(projectDir) {
  const result = spawnSync('git', ['--no-pager', 'show', `HEAD:./${CONFIG_FILE}`], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: GIT_SHOW_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitSafeEnv({
      ...process.env,
      LC_ALL: 'C',
      LANGUAGE: undefined,
      // git needs none of the operator's secrets.
      VIBECARBON_STATE_PASSPHRASE: undefined,
    }),
  });
  if (result.error) {
    if (/** @type {NodeJS.ErrnoException} */ (result.error).code === 'ENOENT') {
      return { state: 'no-git' };
    }
    return { state: 'unknown', detail: result.error.message };
  }
  if (result.status === 0) return { state: 'committed', content: result.stdout };
  const stderr = String(result.stderr ?? '');
  if (NOT_A_CHECKOUT.test(stderr)) return { state: 'no-git' };
  if (NOT_AT_HEAD.test(stderr)) return { state: 'absent' };
  const detail =
    stderr
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? `git exited with code ${result.status}`;
  return { state: 'unknown', detail };
}
