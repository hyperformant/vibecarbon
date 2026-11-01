/**
 * addons_ready: every background add-on came up after the deploy.
 *
 * Compose deploys start the add-ons (observability, n8n, metabase) in a
 * detached job once the core stack serves (src/lib/services/addon-start.js),
 * so `deploy.total` ends at a serving app. That is not a relaxation: this
 * check still requires every enabled background add-on to reach `running` in
 * the job's status file on the role primary, within one bounded wait, and a
 * failure quotes the add-on's own log. It runs before the feature checks
 * (Grafana, n8n, metabase) so they find their service up.
 *
 * skip only when no background add-on is enabled or the mode is k8s (whose
 * add-ons are not deferred). A compose deploy with add-ons but no SSH handle
 * FAILS (hollow-pass-census.test.ts).
 */

import {
  ADDON_STATE_DIR,
  ADDON_STATUS_FILE,
  backgroundAddons,
  parseAddonStatus,
} from '../../../src/lib/services/addon-start.js';
import { enabledAddonNames } from '../../../src/lib/services/standby-policy.js';
import type { DeployMode, VerificationResult } from '../scenarios/types.js';
import { defaultRun, fail, missingHandle, type RemoteRun } from './ha-integrity.js';

/** The one bound the harness gives the add-ons after the deploy returns. */
export const ADDONS_READY_BUDGET_MS = 900_000;
const POLL_MS = 10_000;
const LOG_TAIL_LINES = 60;

export interface AddonsReadyOptions {
  mode: DeployMode;
  projectName: string;
  /** The enabled feature names (config.features). */
  features: readonly string[];
  /** The role primary (or the single server). */
  ip: string | null | undefined;
  sshKeyPath: string | null;
  run?: RemoteRun;
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The add-ons the deploy left to the background job, by name. */
export function expectedBackgroundAddons(features: readonly string[]): string[] {
  const envConfig = Object.fromEntries(features.map((f) => [f, true]));
  return backgroundAddons(enabledAddonNames(envConfig)).map((a) => a.name);
}

export async function checkAddonsReady(opts: AddonsReadyOptions): Promise<VerificationResult> {
  const checkName = 'addons_ready';
  const expected = expectedBackgroundAddons(opts.features);
  if (!opts.mode.startsWith('compose') || expected.length === 0) {
    return {
      checkName,
      status: 'skip',
      details: {
        skipped: opts.mode.startsWith('compose')
          ? 'no background add-on enabled'
          : 'k8s add-ons are not started in the background',
      },
    };
  }
  const missing = missingHandle(opts.ip, opts.sshKeyPath, 'primary');
  if (missing) return fail(checkName, `cannot read the add-on status: ${missing}`);
  const ip = opts.ip as string;
  const run =
    opts.run ?? defaultRun(opts.mode, opts.projectName, opts.sshKeyPath as string, checkName);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + (opts.budgetMs ?? ADDONS_READY_BUDGET_MS);
  const dir = `/opt/${opts.projectName}`;

  let states: ReturnType<typeof parseAddonStatus> = [];
  for (;;) {
    const read = await run(ip, `cat ${dir}/${ADDON_STATUS_FILE} 2>/dev/null || true`);
    states = read.ok ? parseAddonStatus(read.output) : states;
    const by = new Map(states.map((s) => [s.name, s]));
    const failed = expected.filter((n) => by.get(n)?.state === 'failed');
    const done = expected.every((n) => by.get(n)?.state === 'running');
    if (done) {
      return {
        checkName,
        status: 'pass',
        responseTimeMs: now() - started,
        details: { addons: expected },
      };
    }
    if (failed.length > 0 || now() >= deadline) {
      const notRunning = expected.filter((n) => by.get(n)?.state !== 'running');
      const logs: string[] = [];
      for (const n of notRunning) {
        const log = await run(
          ip,
          `tail -n ${LOG_TAIL_LINES} ${dir}/${ADDON_STATE_DIR}/${n}.log 2>/dev/null || true`,
        );
        logs.push(`--- ${n} (${by.get(n)?.state ?? 'no status'}) ---\n${log.output.trim()}`);
      }
      const summary = notRunning
        .map(
          (n) =>
            `${n}: ${by.get(n)?.state ?? 'no status'}${by.get(n)?.reason ? ` (${by.get(n)?.reason})` : ''}`,
        )
        .join('; ');
      return fail(
        checkName,
        failed.length > 0
          ? `add-on failed to start: ${summary}\n${logs.join('\n')}`
          : `add-ons not running after ${Math.round((now() - started) / 1000)}s: ${summary}\n${logs.join('\n')}`,
        { states },
      );
    }
    await sleep(POLL_MS);
  }
}
