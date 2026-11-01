/**
 * The compose tiers' shared boot user-data (carbon/cloud-init/docker-ce-setup.yaml),
 * rendered: the boot image pull's list filled from src/lib/images.js. Every
 * provider's loader (hetzner-compose.js and the scale path through
 * compose/index.js loadCloudInitScript; the DigitalOcean, Linode, Vultr and
 * Scaleway renderers, which splice their Docker install on top) starts here,
 * so no server boots with the placeholder.
 *
 * Changing this output never replaces an existing server: every server
 * resource ignores changes to its user data (serverResourceOptions).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbImageRef, dockerSocketProxyImageRef, traefikImageRef } from '../images.js';

const CLOUD_INIT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../carbon/cloud-init/docker-ce-setup.yaml',
);

/** The token docker-ce-setup.yaml's boot-pull.sh carries for its image list. */
export const BOOT_PULL_PLACEHOLDER = '__VIBECARBON_BOOT_PULL_IMAGES__';

/**
 * The pinned core images a compose server pulls at boot: the db image and the
 * traefik and docker-socket-proxy mirrors, the same refs the compose files
 * run (the db through DB_IMAGE:DB_IMAGE_TAG in the server .env). Add-ons are
 * not here: they start in the background after the deploy (addon-start.js).
 * @returns {string[]}
 */
export function bootPullImages() {
  return [dbImageRef(), traefikImageRef(), dockerSocketProxyImageRef()];
}

/** Fill the boot pull's image list in the shared cloud-init text. */
export function renderComposeCloudInit(sharedYaml) {
  if (!sharedYaml.includes(BOOT_PULL_PLACEHOLDER)) {
    throw new Error(
      `renderComposeCloudInit: ${BOOT_PULL_PLACEHOLDER} not found in the shared cloud-init ` +
        '(carbon/cloud-init/docker-ce-setup.yaml), file shape changed',
    );
  }
  return sharedYaml.replaceAll(BOOT_PULL_PLACEHOLDER, bootPullImages().join(' '));
}

/** The shared compose cloud-init, rendered (Hetzner's user data as is). */
export function loadComposeCloudInit() {
  return renderComposeCloudInit(readFileSync(CLOUD_INIT_PATH, 'utf-8'));
}
