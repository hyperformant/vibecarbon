/**
 * The shared git config guard.
 *
 * Every worktree of a checkout shares ONE .git/config. Twice something run
 * during the test suites changed it unnoticed: core.bare=true (found
 * 2026-11-04) and user.name=T / user.email=t@example.test (found 2026-11-11,
 * already overriding the developer's identity on every local commit since about
 * 2026-11-06). Nothing looked, so the damage showed up days later as wrong
 * commit authors.
 *
 * The vitest global setup takes a snapshot of `git config --local --list`
 * before any test runs; the teardown takes another and fails the run, naming
 * the keys, when they differ. It restores nothing: a changed key is evidence
 * of a bug somewhere, and quietly repairing it would hide the culprit.
 *
 * Only the keys a test could plausibly write and that matter are compared
 * (WATCHED_KEY): `core.*` (core.bare among them), `user.*` (who commits) and
 * `remote.<name>.url` (where pushes go). Everything else is left out, because
 * other tools write it in normal operation while a suite runs, often from
 * another session in another worktree: git itself rewrites `branch.*` on
 * push -u, branch -u and branch deletion, `gh repo set-default` writes
 * `remote.<name>.gh-resolved`, and `git maintenance start` writes
 * `maintenance.*`. None of those can change who commits, where pushes go, or
 * whether the repo is bare, which is what the guard is for.
 */
import { execFileSync } from 'node:child_process';
import { gitScrubbedEnv } from './git-env.js';

export type ConfigSnapshot = ReadonlyMap<string, string[]>;

/** The keys the guard compares; see the file header. */
const WATCHED_KEY = /^(core\.|user\.|remote\..+\.url$)/;

/** Parse `git config --list -z` output (`key\nvalue\0` records) into key -> values. */
export function parseConfigList(output: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const nl = record.indexOf('\n');
    const key = nl < 0 ? record : record.slice(0, nl);
    const value = nl < 0 ? '' : record.slice(nl + 1);
    if (!WATCHED_KEY.test(key)) continue;
    map.set(key, [...(map.get(key) ?? []), value]);
  }
  return map;
}

/** One git call: the repo-level config shared by every worktree of `cwd`. */
export function snapshotLocalConfig(cwd: string): Map<string, string[]> {
  const out = execFileSync('git', ['config', '--local', '--list', '-z'], {
    cwd,
    env: gitScrubbedEnv(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return parseConfigList(out);
}

/** Human lines for every key that differs; empty when the snapshots agree. */
export function diffConfigSnapshots(before: ConfigSnapshot, after: ConfigSnapshot): string[] {
  const show = (v: string[] | undefined) => (v === undefined ? '(unset)' : JSON.stringify(v));
  const lines: string[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    if (JSON.stringify(b) !== JSON.stringify(a)) lines.push(`${key}: ${show(b)} -> ${show(a)}`);
  }
  return lines;
}

/** Throws, naming the keys, when the config differs from `before`. */
export function assertConfigUnchanged(before: ConfigSnapshot, after: ConfigSnapshot): void {
  const changed = diffConfigSnapshots(before, after);
  if (changed.length === 0) return;
  throw new Error(
    `the shared git config (.git/config, used by every worktree) changed during the run:\n  ${changed.join('\n  ')}\n` +
      'Something wrote it while the suites ran: a test, the code under test, or another session ' +
      'working in this checkout. Nothing was restored, so check each key above and repair it by ' +
      'hand if the change is unwanted. A test that writes it usually runs git without a scrubbed ' +
      'environment (GIT_DIR inherited from a hook) or without `--global`.',
  );
}
