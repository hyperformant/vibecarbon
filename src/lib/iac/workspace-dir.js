/**
 * The directory each Pulumi workspace this process opens runs in, removed
 * when the process exits.
 *
 * Given no workDir, the Automation SDK (3.274.1) makes one per workspace
 * (mkdtemp `automation-*` under the OS temp dir) and never removes it. One
 * was left behind for every stack open, about 2,000 in /tmp by 2026-11-11.
 * Each holds the workspace's Pulumi.yaml (the backend URL) and, once the
 * stack has settings or a migration ran, Pulumi.<stack>.yaml with the
 * stack's encryptionsalt.
 *
 * No later process reuses one: every open makes a new workspace. Within this
 * process the Stack handed out runs every later command in its directory
 * (the passphrase probe, the migration child, refresh, up, destroy), and a
 * caller may hold it until the command ends, so the directory lives until
 * the process exits. The owner is a process 'exit' hook, not the end of each
 * command: commands end in many places (returns, process.exit on an error,
 * an uncaught throw), and 'exit' runs on all of them. cli.js turns SIGINT
 * into process.exit(130), so Ctrl-C runs it too; only a SIGKILL leaves the
 * directories behind, as every run did before.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @type {Set<string>} */
const dirs = new Set();
let hooked = false;

/**
 * A new, empty directory for one workspace, removed at process exit.
 * @returns {string}
 */
export function makeWorkspaceDir() {
  const dir = mkdtempSync(join(tmpdir(), 'automation-'));
  dirs.add(dir);
  if (!hooked) {
    process.on('exit', removeWorkspaceDirs);
    hooked = true;
  }
  return dir;
}

/**
 * Remove every directory makeWorkspaceDir made, and the exit hook with them.
 * Runs at process exit, and from the test setup after each test file.
 */
export function removeWorkspaceDirs() {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // At exit nothing can act on a failure, and a throw here would replace
      // the command's exit code: the next directory is still removed.
    }
    dirs.delete(dir);
  }
  if (hooked) {
    process.off('exit', removeWorkspaceDirs);
    hooked = false;
  }
}

/** The directories made and not yet removed, for tests. */
export function __workspaceDirsForTests() {
  return [...dirs];
}
