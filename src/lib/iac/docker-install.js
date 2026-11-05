/**
 * The one Docker install every compose server runs, on every provider.
 *
 * Every compose server boots plain Ubuntu 24.04 and installs the latest Docker
 * from Docker's own stable apt repo, spliced into the shared cloud-init's
 * `runcmd:` list. Why one install and not each provider's prebuilt image: the
 * deploy's image delivery (src/lib/deploy/layer-delta-remote.sh) runs
 * `docker save --platform` on the server, which needs Docker 28+, and Hetzner's
 * prebuilt `docker-ce` app image shipped 27.5.1 (2026-11-04 e2e:
 * `unknown flag: --platform`).
 *
 * No version is pinned, on purpose: a Docker security fix reaches the next new
 * server without a CLI release. tests/unit/iac/docker-install-census.test.ts
 * fails on a pin.
 *
 * Boot refreshes only what it installs: the apt update is limited to Docker's
 * own source and runs with Ubuntu's post-update hooks silenced; cloud-init no
 * longer does a `package_update`. The other packages we use (ufw,
 * unattended-upgrades) are already installed on the images we boot; Hetzner and
 * Linode ship no apt lists at all. If the Docker install cannot find a package,
 * a plain full update is the fallback (see aptInstallOrRefresh).
 *
 * ASCII-only: DigitalOcean and Scaleway user data must be pure ASCII.
 */
import { aptInstallOrRefresh, aptQuietUpdate } from '../deploy/apt.js';

export const DOCKER_PACKAGES = Object.freeze([
  'docker-ce',
  'docker-ce-cli',
  'containerd.io',
  'docker-buildx-plugin',
  'docker-compose-plugin',
]);

const DOCKER_SOURCE_ONLY =
  '-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0';

// Idempotent / safe to re-run: `install -m` re-applies the same mode, the curl
// step overwrites the keyring with identical bytes, and installing an already
// package already at its newest version is a no-op.
export const DOCKER_INSTALL_RUNCMD = [
  "  - [sh, -c, 'install -m 0755 -d /etc/apt/keyrings']",
  "  - [sh, -c, 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc']",
  "  - [sh, -c, 'chmod a+r /etc/apt/keyrings/docker.asc']",
  '  - [sh, -c, \'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null\']',
  // Lock timeout, not bare apt-get: runcmd runs while unattended-upgrades is
  // still holding dpkg's lock-frontend on first boot, and apt's default is to
  // fail on contention rather than wait. See src/lib/deploy/apt.js.
  `  - [sh, -c, '${aptQuietUpdate(DOCKER_SOURCE_ONLY)}']`,
  `  - [sh, -c, '${aptInstallOrRefresh(DOCKER_PACKAGES.join(' '))}']`,
].join('\n');

/**
 * Splice the Docker install into the shared compose cloud-init's `runcmd:`
 * list, immediately after the `runcmd:` key, so it runs BEFORE the shared
 * file's own `systemctl enable --now docker`. Throws if the anchor is gone: a
 * silent no-op would ship a server that fails at the first `docker compose up`.
 * @param {string} sharedYaml - carbon/cloud-init/docker-ce-setup.yaml, rendered
 * @param {string} [caller] - renderer name, for the error message
 * @returns {string}
 */
export function spliceDockerInstall(sharedYaml, caller = 'spliceDockerInstall') {
  const anchor = '\nruncmd:\n';
  const idx = sharedYaml.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      `${caller}: \`runcmd:\` block not found in shared cloud-init ` +
        '(carbon/cloud-init/docker-ce-setup.yaml), file shape changed, update the splice anchor',
    );
  }
  const insertAt = idx + anchor.length;
  return `${sharedYaml.slice(0, insertAt)}${DOCKER_INSTALL_RUNCMD}\n${sharedYaml.slice(insertAt)}`;
}
