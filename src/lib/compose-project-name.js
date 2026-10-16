/**
 * Decide the local docker compose project name for `vibecarbon up`.
 *
 * Compose derives the project name (and so the db volume name) from the folder
 * basename, so renaming a folder strands its stack and boots an empty
 * database. `up` pins the name in `.env` instead; this resolves what to pin.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { localComposeEnv } from './images.js';
import { deriveComposeProjectName } from './subnet.js';

/**
 * @param {object} args
 * @param {string} args.cwd - project directory
 * @param {string | null} args.projectName - PROJECT_NAME from the env files
 * @param {string | null} args.pinned - COMPOSE_PROJECT_NAME from `.env`, if any
 * @param {Array<{ project: string, workingDir: string, containers: Array<{ name: string }> }>} args.stacks
 * @param {(path: string) => boolean} [args.exists]
 * @param {(path: string) => string} [args.realpath] - resolves symlinks; falls back to the raw path if it throws
 * @returns {{ action: 'keep' | 'pin' | 'adopt' | 'refuse', name?: string, from?: string }}
 */
export function resolveComposeProjectName({
  cwd,
  projectName,
  pinned,
  stacks,
  exists = existsSync,
  realpath = realpathSync,
}) {
  // Container names come from ${PROJECT_NAME} and are unique per host, so
  // `${projectName}-db` identifies the stack that owns this project's data.
  const owner = projectName
    ? stacks.find((s) => s.containers.some((ct) => ct.name === `${projectName}-db`))
    : undefined;

  if (!owner) {
    return pinned
      ? { action: 'keep', name: pinned }
      : { action: 'pin', name: deriveComposeProjectName(basename(cwd)) };
  }
  if (!exists(owner.workingDir)) {
    return { action: 'adopt', name: owner.project, from: owner.workingDir };
  }
  // process.cwd() is a realpath but compose's working_dir label may be a
  // symlinked path, so compare resolved paths before calling this a copy.
  const real = (path) => {
    try {
      return realpath(path);
    } catch {
      return path;
    }
  };
  if (owner.workingDir === cwd || real(owner.workingDir) === real(cwd)) {
    // A stale pin would start a second project and clash on container names.
    return pinned === owner.project
      ? { action: 'keep', name: pinned }
      : { action: 'pin', name: owner.project };
  }
  return { action: 'refuse', from: owner.workingDir };
}

/**
 * After `adopt`, remove the moved stack's containers so `up` recreates them
 * from the new folder with fresh compose labels (compose does not recreate an
 * unchanged container, so its working_dir label would keep pointing at the old
 * folder). NEVER `-v`: the volumes hold the user's data.
 *
 * @param {string} name - the adopted compose project name
 * @param {{ run?: (args: string[]) => unknown, cwd?: string }} [deps]
 * @returns {boolean} true on success, false if the teardown failed
 */
export function releaseMovedStack(
  name,
  {
    cwd,
    run = (args) => execFileSync('docker', args, { cwd, env: localComposeEnv(), stdio: 'pipe' }),
  } = {},
) {
  try {
    run(['compose', '-p', name, 'down', '--remove-orphans']);
    return true;
  } catch {
    return false;
  }
}
