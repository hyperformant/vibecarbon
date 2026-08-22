import { sshRunAsync } from './index.js';
// Used by ensureComposeRegistry below AND re-exported, so these two need a
// real local binding.
import { REGISTRY_CONTAINER, registryRunCommand } from './registry-config.js';

// Pure passthroughs — this module is the compose tier's single import surface
// for the registry, but it has no local use for these.
export {
  COMPOSE_PUSH_SETTLE_DELAYS_MS,
  REGISTRY_IMAGE,
  REGISTRY_PORT,
  REGISTRY_PREFIX,
  REGISTRY_VOLUME,
  registryEnsureShell,
} from './registry-config.js';
export { REGISTRY_CONTAINER, registryRunCommand };

/**
 * Ensure the per-server registry container is running on `serverIp`.
 *
 * A running container is a no-op (idempotent); an absent/stopped one is
 * (re)created via the shared `registryRunCommand()`. Throws (via
 * `sshRunAsync`, which never swallows) if the create fails — the caller
 * falls back to sideload deliberately rather than this module swallowing
 * the error.
 *
 * @param {string} serverIp
 * @param {string} sshKeyPath
 * @returns {Promise<void>}
 */
export async function ensureComposeRegistry(serverIp, sshKeyPath) {
  // `docker ps -q` exits 0 whether or not it matches, so this never throws on
  // "not running" — an empty stdout means we need to create it.
  const running = await sshRunAsync(
    serverIp,
    sshKeyPath,
    `docker ps --filter name=^${REGISTRY_CONTAINER}$ --filter status=running -q`,
  );
  if (typeof running === 'string' && running.trim()) return; // already up — idempotent no-op

  // A stopped container of the same name would block `docker run --name`;
  // clear it first (ignore "no such container" when there's nothing to remove).
  await sshRunAsync(serverIp, sshKeyPath, `docker rm -f ${REGISTRY_CONTAINER}`, {
    ignoreError: true,
  });
  await sshRunAsync(serverIp, sshKeyPath, registryRunCommand());
}
