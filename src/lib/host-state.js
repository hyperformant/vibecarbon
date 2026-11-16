/**
 * The host-state format: what each server's reporter publishes (the node
 * annotation on k8s, /run/vibecarbon-host/state.json on compose) and how the
 * CLI and the app read it. Reporter: carbon/cloud-init/k3s/_host-reporter.sh.
 */

export const HOST_STATE_ANNOTATION = 'vibecarbon.dev/host-state';

const MAX_PACKAGES = 20;

/**
 * Packages whose maintainer scripts call
 * /usr/share/update-notifier/notify-reboot-required. Checked on Ubuntu 26.04
 * (tests/integration/docker/host-reporter-ubuntu.test.ts): dbus, libc6 and
 * libpam0g. The kernel and firmware patterns come from Ubuntu's kernel
 * packaging (linux-image, linux-modules, linux-base, linux-firmware), and
 * systemd is listed on the same grounds without a 26.04 check.
 */
export const REBOOT_TRIGGER_PATTERNS = [
  /^linux-(image|modules|base|firmware)/,
  /^libc6$/,
  /^systemd$/,
  /^dbus$/,
  /^libpam0g$/,
];

const KERNEL_PATTERN = /^linux-/;

/**
 * @typedef {{ host: string, rebootRequired: boolean, since: string | null, packages: string[] }} HostState
 */

/**
 * @param {string} text the reporter's JSON line
 * @returns {HostState | null} null for anything not version 1 or malformed
 */
export function parseHostState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
  if (typeof raw.host !== 'string' || typeof raw.rebootRequired !== 'boolean') return null;
  if (raw.since !== null && typeof raw.since !== 'string') return null;
  if (!Array.isArray(raw.packages) || !raw.packages.every((p) => typeof p === 'string'))
    return null;
  return {
    host: raw.host,
    rebootRequired: raw.rebootRequired,
    since: raw.since,
    packages: raw.packages.slice(0, MAX_PACKAGES),
  };
}

/**
 * @param {object} node a Kubernetes Node
 * @returns {{ name: string, reporting: boolean, state: HostState | null }}
 */
export function hostStateFromNode(node) {
  const name = node?.metadata?.name ?? '';
  const text = node?.metadata?.annotations?.[HOST_STATE_ANNOTATION];
  const state = typeof text === 'string' ? parseHostState(text) : null;
  return { name, reporting: state !== null, state };
}

/**
 * @param {string[]} packages
 * @returns {string | null} the first kernel-pattern package, else the first
 */
export function mainPackage(packages) {
  return packages.find((p) => KERNEL_PATTERN.test(p)) ?? packages[0] ?? null;
}
