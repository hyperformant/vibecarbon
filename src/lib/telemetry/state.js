/**
 * Persistent telemetry state: the random machine ID and opt-out flags.
 * Stored at ~/.vibecarbon/telemetry.json. Every function here is
 * throw-proof — telemetry must never break a command.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIR = join(homedir(), '.vibecarbon');
const FILE_NAME = 'telemetry.json';

function readState(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, FILE_NAME), 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(state, stateDir) {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, FILE_NAME), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Read-only home, disk full — run stateless rather than break the command.
  }
}

/**
 * Load (creating if needed) the telemetry state.
 *
 * @param {string} [stateDir]
 * @returns {{ machineId: string, disabled: boolean, noticeShown: boolean }}
 */
export function getTelemetryState(stateDir = DEFAULT_DIR) {
  const raw = readState(stateDir);
  if (raw && typeof raw.machineId === 'string' && raw.machineId.length === 36) {
    return { machineId: raw.machineId, disabled: !!raw.disabled, noticeShown: !!raw.noticeShown };
  }
  const fresh = { machineId: randomUUID(), disabled: false, noticeShown: false };
  writeState(fresh, stateDir);
  return fresh;
}

/**
 * @param {boolean} disabled
 * @param {string} [stateDir]
 */
export function setTelemetryDisabled(disabled, stateDir = DEFAULT_DIR) {
  writeState({ ...getTelemetryState(stateDir), disabled }, stateDir);
}

/** @param {string} [stateDir] */
export function markNoticeShown(stateDir = DEFAULT_DIR) {
  writeState({ ...getTelemetryState(stateDir), noticeShown: true }, stateDir);
}

/**
 * The full opt-out matrix for analytics + error reports.
 * (The update check has its own, narrower gate: CI only.)
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [stateDir]
 * @returns {boolean}
 */
export function isAnalyticsDisabled(env = process.env, stateDir = DEFAULT_DIR) {
  const truthy = (v) => v !== undefined && v !== '' && v !== '0';
  if (env.VIBECARBON_TELEMETRY_DISABLED === '1') return true;
  if (truthy(env.DO_NOT_TRACK)) return true;
  if (truthy(env.CI)) return true;
  return getTelemetryState(stateDir).disabled;
}
