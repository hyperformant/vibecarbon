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
 * `branch.*` keys are left out of the comparison: git itself rewrites them on
 * push -u, branch -u and branch deletion, and other sessions do that in other
 * worktrees while a suite runs. They cannot change who commits or whether the
 * repo is bare, which is what the guard is for.
 */
import { execFileSync } from 'node:child_process';
import { gitScrubbedEnv } from './git-env.js';

export type ConfigSnapshot = ReadonlyMap<string, string[]>;

/** Keys git rewrites in normal operation; see the file header. */
const IGNORED_KEY = /^branch\./;

/** Parse `git config --list -z` output (`key\nvalue\0` records) into key -> values. */
export function parseConfigList(output: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const nl = record.indexOf('\n');
    const key = nl < 0 ? record : record.slice(0, nl);
    const value = nl < 0 ? '' : record.slice(nl + 1);
    if (IGNORED_KEY.test(key)) continue;
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
    `the shared git config (.git/config, used by every worktree) changed during this test run:\n  ${changed.join('\n  ')}\n` +
      'A test or the code under test wrote it, probably a git call that ran without a scrubbed ' +
      'environment (GIT_DIR inherited from a hook) or without `--global`. Nothing was restored: ' +
      'repair the keys above by hand, then find the writer.',
  );
}
