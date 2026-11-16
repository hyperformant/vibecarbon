/**
 * The host-state format: what each server's reporter publishes (the node
 * annotation on k8s, /run/vibecarbon-host/state.json on compose) and how the
 * CLI and the app read it. Reporter: carbon/cloud-init/k3s/_host-reporter.sh.
 */

export const HOST_STATE_ANNOTATION = 'vibecarbon.dev/host-state';

const MAX_PACKAGES = 20;

// The parser is the trust boundary: a k8s node's own credential can rewrite its
// annotation, and what passes here reaches a terminal, HTML and email. The app's
// copy (carbon/src/server/lib/host-maintenance.ts) must stay identical.
const MAX_TEXT_LENGTH = 16384;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9-]+)?$/;

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
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
  if (typeof raw.host !== 'string' || typeof raw.rebootRequired !== 'boolean') return null;
  if (!HOST_PATTERN.test(raw.host)) return null;
  if (raw.since !== null && (typeof raw.since !== 'string' || !SINCE_PATTERN.test(raw.since)))
    return null;
  if (!Array.isArray(raw.packages) || !raw.packages.every((p) => typeof p === 'string'))
    return null;
  return {
    host: raw.host,
    rebootRequired: raw.rebootRequired,
    since: raw.since,
    packages: raw.packages.filter((p) => PACKAGE_PATTERN.test(p)).slice(0, MAX_PACKAGES),
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
