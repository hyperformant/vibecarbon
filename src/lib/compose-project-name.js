/**
 * Decide the local docker compose project name for `vibecarbon up`.
 *
 * Compose derives the project name (and so the db volume name) from the folder
 * basename, so renaming a folder strands its stack and boots an empty
 * database. `up` pins the name in `.env` instead; this resolves what to pin.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { deriveComposeProjectName } from './subnet.js';

/**
 * @param {object} args
 * @param {string} args.cwd - project directory
 * @param {string | null} args.projectName - PROJECT_NAME from the env files
 * @param {string | null} args.pinned - COMPOSE_PROJECT_NAME from `.env`, if any
 * @param {Array<{ project: string, workingDir: string, containers: Array<{ name: string }> }>} args.stacks
 * @param {(path: string) => boolean} [args.exists]
 * @returns {{ action: 'keep' | 'pin' | 'adopt' | 'refuse', name?: string, from?: string }}
 */
export function resolveComposeProjectName({
  cwd,
  projectName,
  pinned,
  stacks,
  exists = existsSync,
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
  if (owner.workingDir === cwd) {
    return pinned ? { action: 'keep', name: pinned } : { action: 'pin', name: owner.project };
  }
  if (!exists(owner.workingDir)) {
    return { action: 'adopt', name: owner.project, from: owner.workingDir };
  }
  return { action: 'refuse', from: owner.workingDir };
}
