/**
 * `vibecarbon telemetry [on|off|status]` — control anonymous usage analytics.
 * The update check is not affected (it carries no data); see
 * https://vibecarbon.com/docs/telemetry
 */

import { c } from './lib/colors.js';
import {
  getTelemetryState,
  isAnalyticsDisabled,
  setTelemetryDisabled,
} from './lib/telemetry/state.js';

/**
 * @param {string[]} args
 * @param {{ stateDir?: string, env?: NodeJS.ProcessEnv }} [opts] injectable for tests
 */
export async function run(args, { stateDir = undefined, env = process.env } = {}) {
  const sub = args[0] || 'status';

  if (sub === 'off') {
    setTelemetryDisabled(true, stateDir);
    console.log(
      `${c.success('✓')} Telemetry disabled. The version update check (no data sent) still runs.`,
    );
    return;
  }
  if (sub === 'on') {
    setTelemetryDisabled(false, stateDir);
    console.log(
      `${c.success('✓')} Telemetry enabled. Details: https://vibecarbon.com/docs/telemetry`,
    );
    return;
  }
  if (sub === 'status') {
    const disabled = isAnalyticsDisabled(env, stateDir);
    console.log(`Telemetry is ${disabled ? c.warning('disabled') : c.success('enabled')}.`);
    if (disabled) {
      const state = getTelemetryState(stateDir);
      if (env.VIBECARBON_TELEMETRY_DISABLED === '1')
        console.log(c.dim('  reason: VIBECARBON_TELEMETRY_DISABLED=1'));
      else if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== '0')
        console.log(c.dim('  reason: DO_NOT_TRACK is set'));
      else if (env.CI && env.CI !== '0') console.log(c.dim('  reason: CI environment'));
      else if (state.disabled)
        console.log(c.dim('  reason: disabled via `vibecarbon telemetry off`'));
    }
    console.log(c.dim('  what is collected: https://vibecarbon.com/docs/telemetry'));
    return;
  }
  console.error(`Unknown subcommand '${sub}'. Usage: vibecarbon telemetry [on|off|status]`);
  process.exit(1);
}
