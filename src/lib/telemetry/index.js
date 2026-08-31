/**
 * Telemetry orchestrator: payload assembly + fire-and-forget senders.
 * Public functions never throw and never block the command (reportCrash
 * waits at most ~2s — the process is exiting anyway).
 * Wire contract: vibecarbon-web /api/v1/telemetry/{events,errors}.
 */

import { randomUUID } from 'node:crypto';
import { c } from '../colors.js';
import { loadManifest, manifestExists, saveManifest } from '../project.js';
import { VERSION } from '../version.js';
import { sanitizeError } from './sanitize.js';
import { getTelemetryState, isAnalyticsDisabled, markNoticeShown } from './state.js';

function apiBase(env) {
  return env.VIBECARBON_API_BASE || 'https://vibecarbon.com';
}

/**
 * Project context from .vibecarbon.json: id (lazily created), provider,
 * deploy target. All null outside a project.
 */
function projectContext(cwd) {
  try {
    if (!manifestExists(cwd)) {
      return { project_id: null, provider: null, deploy_target: null };
    }
    const manifest = loadManifest(cwd);
    if (!manifest.projectId) {
      manifest.projectId = randomUUID();
      saveManifest(manifest, cwd);
    }
    const envs = manifest.environments || {};
    const envCfg = envs.prod || envs[Object.keys(envs)[0]] || {};
    return {
      project_id: manifest.projectId,
      provider: envCfg.provider || null,
      deploy_target: envCfg.deployMode || null,
    };
  } catch {
    return { project_id: null, provider: null, deploy_target: null };
  }
}

function buildPayload(command, { cwd, stateDir }) {
  const [major, minor] = process.versions.node.split('.');
  return {
    machine_id: getTelemetryState(stateDir).machineId,
    ...projectContext(cwd),
    command,
    cli_version: VERSION,
    node_version: `${major}.${minor}`,
    platform: process.platform,
    arch: process.arch,
  };
}

function post(path, payload, { env, fetchImpl }) {
  return fetchImpl(`${apiBase(env)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  });
}

/**
 * Fire the usage event for a command run. Synchronous facade; the POST
 * happens in the background and all failures vanish.
 *
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, stateDir?: string, fetchImpl?: typeof fetch }} [opts]
 */
export function recordCommandStart(
  command,
  { env = process.env, cwd = process.cwd(), stateDir = undefined, fetchImpl = fetch } = {},
) {
  try {
    if (isAnalyticsDisabled(env, stateDir)) return;
    maybeShowFirstRunNotice(stateDir);
    const payload = buildPayload(command, { cwd, stateDir });
    post('/api/v1/telemetry/events', payload, { env, fetchImpl }).catch(() => {});
  } catch {
    // never break the command
  }
}

/**
 * Report a crash, waiting at most ~2s. Never rejects.
 *
 * @param {string} command
 * @param {Error} error
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, stateDir?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<void>}
 */
export async function reportCrash(
  command,
  error,
  { env = process.env, cwd = process.cwd(), stateDir = undefined, fetchImpl = fetch } = {},
) {
  try {
    if (isAnalyticsDisabled(env, stateDir)) return;
    const payload = { ...buildPayload(command, { cwd, stateDir }), ...sanitizeError(error) };
    await Promise.race([
      post('/api/v1/telemetry/errors', payload, { env, fetchImpl }).catch(() => {}),
      new Promise((r) => {
        // .unref() so a fast POST win doesn't leave this timer holding the
        // event loop open past the process's own exit.
        const t = setTimeout(r, 2000);
        if (typeof t?.unref === 'function') t.unref();
      }),
    ]);
  } catch {
    // never break the exit path
  }
}

/** One-time disclosure notice, printed to stderr so it never pollutes -json output. */
function maybeShowFirstRunNotice(stateDir) {
  const state = getTelemetryState(stateDir);
  if (state.noticeShown || !process.stderr.isTTY) return;
  markNoticeShown(stateDir);
  console.error(
    c.dim(
      [
        '',
        'vibecarbon collects anonymous usage data (command names + versions,',
        'never arguments, paths, or personal data) to improve the CLI.',
        'Details: https://vibecarbon.com/docs/telemetry',
        'Opt out: vibecarbon telemetry off   (or export DO_NOT_TRACK=1)',
        '',
      ].join('\n'),
    ),
  );
}
