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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADDON_STATE_DIR,
  ADDON_STATUS_READ_CMD,
  backgroundAddons,
  resolveAddonStates,
} from '../../../src/lib/services/addon-start.js';
import { enabledAddonNames } from '../../../src/lib/services/standby-policy.js';
import { classifyContainer, rowsFromDockerPs } from '../../../src/lib/status/container-rows.js';
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
  /**
   * A status file whose job started before this (the env's last deploy
   * attempt or failover, addonStatusNotBefore) is stale: the add-ons'
   * containers decide instead.
   */
  notBeforeMs?: number;
}

/** The env's last deploy attempt or failover, from the project's .vibecarbon.json. */
export function addonStatusNotBefore(projectDir: string, env: string): number {
  try {
    const path = join(projectDir, '.vibecarbon.json');
    if (!existsSync(path)) return 0;
    const envConfig = JSON.parse(readFileSync(path, 'utf8'))?.environments?.[env] ?? {};
    return Math.max(
      Date.parse(envConfig.lastAttempt ?? '') || 0,
      Date.parse(envConfig.lastFailover ?? '') || 0,
    );
  } catch {
    return 0;
  }
}

/** The add-ons the deploy left to the background job, by name. */
export function expectedBackgroundAddons(features: readonly string[]): string[] {
  return expectedAddonServices(features).map((a) => a.name);
}

function expectedAddonServices(features: readonly string[]) {
  const envConfig = Object.fromEntries(features.map((f) => [f, true]));
  return backgroundAddons(enabledAddonNames(envConfig)).map((a) => ({
    name: a.name,
    services: a.services,
  }));
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

  const withServices = expectedAddonServices(opts.features);
  let states: ReturnType<typeof resolveAddonStates> = [];
  for (;;) {
    // The job's status (current only if it started after notBeforeMs), and the
    // add-ons' containers for when it is missing or stale (a promoted node,
    // or a file left from before a failback): resolveAddonStates decides.
    const read = await run(ip, ADDON_STATUS_READ_CMD(opts.projectName));
    const ps = await run(
      ip,
      `docker ps -a --filter name=^${opts.projectName}- --format '{{.Names}}\t{{.State}}\t{{.Status}}'`,
    );
    const containers = new Map(
      rowsFromDockerPs(ps.ok ? ps.output : '', opts.projectName).map((r) => [
        r.container,
        classifyContainer(r.container, r.state, r.status),
      ]),
    );
    states = resolveAddonStates({
      text: read.ok ? read.output : '',
      expected: withServices,
      notBeforeMs: opts.notBeforeMs ?? 0,
      containers,
    });
    const by = new Map(states.map((s) => [s.name, s]));
    const failed = expected.filter((n) => ['failed', 'stopped'].includes(by.get(n)?.state ?? ''));
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
