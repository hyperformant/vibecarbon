/**
 * Docker Hub credential resolution — operator-shell-level only.
 *
 * Docker Hub is the one credential in the operator-secret family that is
 * NOT part of the per-project `.env.local` store (see config-registry.js's
 * `operator-secret` class docblock and the owner decision it links to):
 * DOCKER_HUB_USERNAME/DOCKER_HUB_TOKEN live exclusively in the operator's
 * shell or CI env. Without them a deploy still works but pulls anonymously,
 * which can exhaust Docker Hub's unauthenticated per-IP rate limit on
 * restore/scale re-deploys (observed: compose-ha restore 'toomanyrequests'
 * 2026-07-21).
 *
 * Shared by orchestrator.js (initial deploy + compose-ha) and scale.js
 * (replacement-server registry auth) — previously duplicated as two
 * near-identical inline reads.
 */

/**
 * @returns {{ username: string, token: string } | null}
 */
export function resolveDockerHubCreds() {
  if (process.env.DOCKER_HUB_USERNAME && process.env.DOCKER_HUB_TOKEN) {
    return { username: process.env.DOCKER_HUB_USERNAME, token: process.env.DOCKER_HUB_TOKEN };
  }
  return null;
}
