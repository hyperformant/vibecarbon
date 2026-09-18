/**
 * Container rows shared by the local Docker block and the remote per-server
 * tables in `vibecarbon status`. One classifier, one `docker ps` line parser,
 * one row formatter — so what a healthy/exited/starting container looks like
 * cannot drift between "your laptop" and "your server".
 */

import { c } from '../colors.js';

// Display names for the core compose services. Anything not listed here
// (vibecarbon add add-ons such as redis, grafana, n8n) renders under its
// compose service name so nothing in the project's stack is ever hidden.
export const SERVICE_DISPLAY_NAMES = {
  traefik: 'Traefik',
  db: 'PostgreSQL',
  kong: 'Kong Gateway',
  auth: 'Auth (GoTrue)',
  rest: 'REST (PostgREST)',
  realtime: 'Realtime',
  storage: 'Storage',
  imgproxy: 'ImgProxy',
  meta: 'Meta',
  studio: 'Studio',
  app: 'App',
};

// Core services render first, in this order; everything else follows
// alphabetically.
export const CORE_SERVICE_ORDER = Object.keys(SERVICE_DISPLAY_NAMES);

/**
 * Derive a status row's health from Docker's own view of the container.
 *
 * `state` is `{{.State}}` (running / exited / restarting / created / paused /
 * dead); `status` is `{{.Status}}`, which carries the compose healthcheck
 * verdict as a suffix ("Up 2m (healthy)", "Up 3s (health: starting)").
 *
 * A running container with no healthcheck is counted healthy but labelled
 * "running" so the table doesn't overclaim. One-shot init containers
 * (`*-setup`) that exited 0 are "done" and excluded from the healthy total.
 *
 * @param {string} container compose service name (prefix already stripped)
 * @param {string} state
 * @param {string} status
 * @returns {{health: 'healthy'|'unhealthy'|'starting'|'done'|'unknown', label: string, detail: string}}
 */
export function classifyContainer(container, state, status) {
  if (!state) return { health: 'unknown', label: 'unknown', detail: status || '' };
  if (state === 'running') {
    if (/\(healthy\)/.test(status)) return { health: 'healthy', label: 'healthy', detail: '' };
    if (/\(unhealthy\)/.test(status))
      return { health: 'unhealthy', label: 'unhealthy', detail: '' };
    if (/\(health: starting\)/.test(status)) {
      return { health: 'starting', label: 'starting', detail: '' };
    }
    return { health: 'healthy', label: 'running', detail: '' };
  }
  if (state === 'exited') {
    const exitCode = status.match(/^Exited \((\d+)\)/)?.[1];
    if (exitCode === '0' && container.endsWith('-setup')) {
      return { health: 'done', label: 'done', detail: '' };
    }
    return { health: 'unhealthy', label: 'exited', detail: status };
  }
  return { health: 'unhealthy', label: state, detail: status };
}

/**
 * Parse `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}'` output
 * into this project's containers. Docker's `--filter name=` is an unanchored
 * regex match, so the JS prefix check is what guarantees only true
 * `${projectName}-*` names survive whatever the daemon returned.
 *
 * @param {string|null|undefined} listing
 * @param {string} projectName
 * @returns {Array<{container: string, state: string, status: string}>}
 */
export function rowsFromDockerPs(listing, projectName) {
  const prefix = `${projectName}-`;
  return (listing || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const [fullName, state = '', status = ''] = line.split('\t');
      return { container: fullName.slice(prefix.length), state, status };
    });
}

/**
 * One rendered row: icon + label coloured by health, then the detail (or the
 * probe latency when there is no detail). Name is padded to 28 columns.
 *
 * @param {{name: string, health: string, label: string, detail: string, latencyMs: number}} row
 * @param {string} [indent]
 * @returns {string}
 */
export function formatContainerRow(row, indent = '  ') {
  let icon;
  let label;
  switch (row.health) {
    case 'healthy':
      icon = c.success('●');
      label = c.dim(row.label);
      break;
    case 'unhealthy':
      icon = c.error('●');
      label = c.error(row.label);
      break;
    case 'starting':
      icon = c.warning('●');
      label = c.warning(row.label);
      break;
    default: // done, unknown
      icon = c.dim('○');
      label = c.dim(row.label);
  }
  const tail = row.detail ? c.dim(row.detail) : row.latencyMs ? c.dim(`${row.latencyMs}ms`) : '';
  return `${indent}${c.dim(row.name.padEnd(28))}${icon} ${label}  ${tail}`;
}
