/**
 * gitScrubbedEnv — the ONE env builder for every test-spawned git process.
 *
 * Git exports repo-targeting variables (GIT_DIR & friends) to every hook it
 * runs, and this repo's pre-push hook runs the test suites. A test git call
 * that inherits them does NOT operate on its `cwd` fixture — git resolves
 * the REAL repo and treats the fixture dir as its work tree. Two incidents:
 *
 *  - 2026-07-08: create.test.ts's rev-list counted 734 host commits instead
 *    of the fixture's 1 (read-only confusion).
 *  - 2026-07-30: the upgrade hygiene test's `git add -A` staged its fixture
 *    tree OVER the feature branch during `git push` — two e2e@test.invalid
 *    commits, one replacing ~196k lines of repo tree, landed on
 *    test/escape-class-guards mid-push (caught before merge). Separately,
 *    another test's un-`--global`ed `git config user.email` wrote a fake
 *    identity into the shared clone's local config under the same leak,
 *    mis-attributing five real commits.
 *
 * This was fixed independently in create.test.ts (2026-07-08) and inline in
 * upgrade.test.ts (2026-07-30) — sibling drift inside the guard PR that
 * exists to stop sibling drift. Converged here; the registry row in
 * tests/unit/lib/shared-helper-consumers.test.ts pins the consumers.
 *
 * Deliberately scoped: only REPO-TARGETING vars are stripped. Transport and
 * safety vars (GIT_SSH_COMMAND, GIT_ASKPASS, GIT_TERMINAL_PROMPT, …) are
 * kept — the e2e setup-repo step pushes to a real GitHub remote under the
 * runner's transport config, and stripping those would break or un-guard
 * the push. `isolateConfig` additionally pins the global/system git config
 * to /dev/null for tests that must neither read nor write an operator
 * identity (their `-c user.*` flags become the only identity git has).
 */

/** Repo-resolution vars git exports to hooks (or that redirect repo/object
 * resolution); inheriting any of them makes a fixture git call operate on —
 * or read from — the real repo instead of `cwd`. The last two are not
 * wrong-repo WRITE hazards and don't reach a client-side pre-push hook, but
 * they are the direct companions of GIT_OBJECT_DIRECTORY /
 * GIT_QUARANTINE_PATH (alternate object stores, discovery ceiling) — kept
 * in the list so the set is coherent rather than leaving readers to guess
 * whether the omission was reasoned (PR #214 re-review). */
const REPO_TARGETING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_QUARANTINE_PATH',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
];

export function gitScrubbedEnv(options: { isolateConfig?: boolean } = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const v of REPO_TARGETING_VARS) {
    delete env[v];
  }
  if (options.isolateConfig) {
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_CONFIG_SYSTEM = '/dev/null';
  }
  return env;
}
