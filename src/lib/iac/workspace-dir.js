/**
 * The directory each Pulumi workspace this process opens runs in, removed
 * when the process exits.
 *
 * Given no workDir, the Automation SDK (3.274.1) makes one per workspace
 * (mkdtemp `automation-*` under the OS temp dir) and never removes it. One
 * was left behind for every stack open, about 2,000 in /tmp by 2026-11-11.
 * Each holds the workspace's Pulumi.yaml (the backend URL, no credentials)
 * and, once the stack has settings or a migration ran, Pulumi.<stack>.yaml
 * with the stack's encryptionsalt, which the state backend holds too.
 *
 * No later process reuses one: every open makes a new workspace. Within this
 * process the Stack handed out runs every later command in its directory
 * (the passphrase probe, the migration child, refresh, up, destroy), and a
 * caller may hold it until the command ends, so the directory lives until
 * the process exits. Its owner is temp-dir.js's exit sweep, not the end of
 * each command: commands end in many places (returns, process.exit on an
 * error, an uncaught throw), and 'exit' runs on all of them. cli.js turns
 * SIGINT into process.exit(130), so Ctrl-C runs it too; only a SIGKILL leaves
 * the directories behind, as every run did before. The temp-dir census
 * (tests/unit/lib/temp-dir-census.test.ts) lists makeWorkspaceDir as a maker
 * the exit sweep owns, for this reason.
 */

import { makeTempDir, removeTempDir } from '../temp-dir.js';

/** The directories makeWorkspaceDir made and removeWorkspaceDirs has not removed. */
const workspaceDirs = new Set();

/**
 * A new, empty, private (0700) directory for one workspace, removed at
 * process exit.
 * @returns {string}
 */
export function makeWorkspaceDir() {
  const dir = makeTempDir('vibecarbon-pulumi-');
  workspaceDirs.add(dir);
  return dir;
}

/**
 * Remove every directory makeWorkspaceDir made, ahead of the exit sweep. The
 * test setup calls it after each test file, before the temp-dir census
 * looks: the worker's exit comes only after. One that cannot be removed
 * stays on the exit sweep, which tries it again and names it.
 */
export function removeWorkspaceDirs() {
  for (const dir of workspaceDirs) removeTempDir(dir);
  workspaceDirs.clear();
}

/** The directories made and not yet removed, for tests. */
export function __workspaceDirsForTests() {
  return [...workspaceDirs];
}
