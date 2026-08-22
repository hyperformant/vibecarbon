/**
 * Shared registry credential helpers.
 *
 * Before Lever 1 this module also housed `buildOnRemote`, `buildAndPush`, and
 * `updateK8sDeployment` — all of which orchestrated a per-deploy SSH-and-docker
 * build flow. That flow is gone: images are built in CI (GitHub Actions) and
 * published to ghcr.io. See `ci-setup.js` for the new flow.
 *
 * What remains here: small helpers for reading ghcr.io credentials from `gh`.
 */

import { runCommand } from './command.js';

/**
 * Get GitHub Container Registry credentials using gh auth.
 * @returns {Promise<{ username: string, token: string }>}
 */
export async function getGHCRCredentials() {
  try {
    const token = runCommand('gh auth token', { silent: true })?.trim();
    const username = runCommand('gh api user -q .login', { silent: true })?.trim();

    if (!token || !username) {
      throw new Error('Could not get GitHub credentials');
    }

    return { username, token };
  } catch (error) {
    throw new Error(
      `Failed to get GitHub credentials. Run 'gh auth login' first.\n${error.message}`,
    );
  }
}
