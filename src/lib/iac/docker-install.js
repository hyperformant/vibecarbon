/**
 * The one Docker install every compose server runs, on every provider.
 *
 * Every compose server boots plain Ubuntu 24.04 and installs the SAME pinned
 * Docker from Docker's own apt repo, spliced into the shared cloud-init's
 * `runcmd:` list. Why one install and not each provider's prebuilt image: the
 * deploy's image delivery (src/lib/deploy/layer-delta-remote.sh) runs
 * `docker save --platform` on the server, which needs Docker 28+. Hetzner's
 * prebuilt `docker-ce` app image shipped 27.5.1 (2026-11-04 e2e:
 * `unknown flag: --platform`) while the floating installs on the other four
 * clouds drifted with every Docker release. One pin, one install path.
 *
 * To bump: fetch
 *   https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages.gz
 * and take the newest `Version:` of each of the five packages below (stable
 * channel; keep Docker >= 28 so `docker save --platform` works), then update
 * DOCKER_VERSIONS. The census in tests/unit/iac/docker-install-census.test.ts
 * follows this file, so it needs no edit.
 *
 * Versions checked 2026-11-04 against the noble amd64 Packages index.
 *
 * Boot refreshes only what it installs: the apt update is limited to Docker's
 * own source (the Ubuntu lists the image ships with already hold everything
 * else we install) and runs with Ubuntu's post-update hooks silenced; cloud-init
 * no longer does a `package_update`. If the install cannot find a package in the
 * shipped lists, a plain full update is the fallback (see aptInstallOrRefresh).
 *
 * ASCII-only: DigitalOcean and Scaleway user data must be pure ASCII.
 */
import { aptInstallOrRefresh, aptQuietUpdate } from '../deploy/apt.js';

export const DOCKER_VERSIONS = Object.freeze({
  'docker-ce': '5:29.9.3-1~ubuntu.24.04~noble',
  'docker-ce-cli': '5:29.9.3-1~ubuntu.24.04~noble',
  'containerd.io': '2.4.2-3~ubuntu.24.04~noble',
  'docker-buildx-plugin': '0.38.1-1~ubuntu.24.04~noble',
  'docker-compose-plugin': '5.7.0-1~ubuntu.24.04~noble',
});

const PINNED_PACKAGES = Object.entries(DOCKER_VERSIONS)
  .map(([name, version]) => `${name}=${version}`)
  .join(' ');

const DOCKER_SOURCE_ONLY =
  '-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0';

// Idempotent / safe to re-run: `install -m` re-applies the same mode, the curl
// step overwrites the keyring with identical bytes, and installing an already
// installed pinned version is a no-op.
export const DOCKER_INSTALL_RUNCMD = [
  "  - [sh, -c, 'install -m 0755 -d /etc/apt/keyrings']",
  "  - [sh, -c, 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc']",
  "  - [sh, -c, 'chmod a+r /etc/apt/keyrings/docker.asc']",
  '  - [sh, -c, \'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null\']',
  // Lock timeout, not bare apt-get: runcmd runs while unattended-upgrades is
  // still holding dpkg's lock-frontend on first boot, and apt's default is to
  // fail on contention rather than wait. See src/lib/deploy/apt.js.
  `  - [sh, -c, '${aptQuietUpdate(DOCKER_SOURCE_ONLY)}']`,
  `  - [sh, -c, '${aptInstallOrRefresh(PINNED_PACKAGES)}']`,
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
