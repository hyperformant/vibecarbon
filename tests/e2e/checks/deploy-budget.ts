/**
 * Per-provider, per-mode, per-class cold-deploy budgets, judged from the deploy's own CLI log.
 *
 * A cold deploy (the e2e db's classifyColdWarm: no passing deploy for the
 * project and env in 24 h, which is every scenario's first deploy) must fit
 * two budgets (ruling D1):
 *
 * - DEPLOY-OWNED: `deploy.total` minus the TLS first look (`deploy.tls.ready`
 *   plus `deploy.tls.snapshot`), the work the deploy controls. A first-ever
 *   deploy waits up to 180 s for Let's Encrypt's HTTP-01 validation (the CA
 *   fetching the challenge from the new server); that wait is the CA's, not ours.
 * - END-TO-END: `deploy.total` itself, a first-ever deploy with TLS issued.
 *
 * `deploy.total` starts when executeDeployment does (after config gathering
 * and the local preflight) and ends at the success outro.
 *
 * Budgets are keyed on provider + mode + CPU class (deploy-budgets.json). A
 * combination with no calibrated row fails with `no budget yet`: it is never a
 * pass for want of a number.
 *
 * Hard limits, no uplink exemption: the cold image delta's bytes are asserted
 * too (10 MB), so a slow uplink moves a deploy by seconds, not minutes. If
 * real runs miss, the budgets are recalibrated from data, never loosened
 * silently.
 *
 * HA cold deploys also hold the state-lock invariants (ruling R6b): no
 * `backpressure` in any `[state] up` line, and a lock wait of at most 15 s. An
 * HA pair takes no state lock (src/lib/iac/state-lock.js), so a wait should be
 * near zero and the 15 s is the alarm that something brought one back.
 * compose-ha's infra fan must stay within 1.25x its slower arm.
 * k8s-ha's standby must not wait on its database for a minute, and the early
 * replication transport must not fail.
 *
 * Never a hollow pass: a log without the markers a judgement rests on fails
 * (tests/unit/e2e/hollow-pass-census.test.ts registers this check). A failure
 * names the three slowest markers, so the message says where the time went.
 */
import { readFileSync } from 'node:fs';
import { getProviderClass } from '../../../src/lib/providers/index.js';
import { parsePerfLines } from '../metrics/reporter.js';
import type { DeployMode, VerificationResult } from '../scenarios/types.js';

/** What a budget is keyed on: where the scenario deployed, and on which CPU class. */
export interface BudgetKey {
  provider: string;
  /** `deployCpuClass()`: the class the deploy actually ran on. */
  cpuClass: string;
}

export interface BudgetRow {
  ownedS: number;
  endToEndS: number;
  /** Samples the row was calibrated from. */
  samples: number;
}

/** provider -> mode -> CPU class -> seconds. Only combinations with data have a row. */
export type BudgetTable = Record<string, Partial<Record<DeployMode, Record<string, BudgetRow>>>>;

/**
 * The calibrated table, written by scripts/calibrate-deploy-budgets.js from the
 * e2e results db (rule: ceil5(p90 + 15) at n >= 4, else ceil5(max + 30)).
 * Never edited by hand.
 */
export const DEPLOY_BUDGET_TABLE: BudgetTable = (
  JSON.parse(readFileSync(new URL('./deploy-budgets.json', import.meta.url), 'utf8')) as {
    budgets: BudgetTable;
  }
).budgets;

/** The class every provider that declares no CPU classes deploys on. */
export const STANDARD_CLASS = 'standard';

/**
 * The CPU class a deploy ran on, from the server type it recorded in
 * `.vibecarbon.json` (compose: `serverType`; k8s: `masterServerType`). A
 * provider with no declared classes is always `standard`. A classed provider
 * whose type is missing or has no class is `unknown`, which has no budget, so
 * the check says so instead of judging against another class's number.
 */
export function deployCpuClass(provider: string, serverType: string | undefined): string {
  const Provider = getProviderClass(provider);
  if ((Provider.CPU_CLASSES?.length ?? 0) === 0) return STANDARD_CLASS;
  return (serverType && Provider.cpuClassOf(serverType)) || 'unknown';
}

export function budgetFor(
  table: BudgetTable,
  mode: DeployMode,
  { provider, cpuClass }: BudgetKey,
): BudgetRow | undefined {
  return table[provider]?.[mode]?.[cpuClass];
}

/** A cold image delta carries the app's own layers on a pulled base: 4-5 MB. */
export const COLD_DELTA_MAX_BYTES = 10_000_000;
/** The alarm for a lock wait that should be near zero (R6b). */
export const HA_LOCK_WAIT_MAX_S = 15;
export const FAN_RATIO_MAX = 1.25;
export const STANDBY_AWAIT_DB_MAX_MS = 60_000;

/** Modes whose app image reaches the server by layer delta (deliverImage). */
const DELTA_MODES: ReadonlySet<DeployMode> = new Set(['compose', 'compose-ha', 'k8s', 'k8s-ha']);

/** compose-ha sends one delta to each of its two servers; every other mode sends one. */
const DELTA_MARKERS: Partial<Record<DeployMode, number>> = { 'compose-ha': 2 };

/**
 * Markers that are not serial work of their own, kept out of the "slowest"
 * list a failure names:
 * - umbrellas that wrap other markers: the totals (`deploy.total`, and
 *   `cli.deploy.total`, the whole CLI process), `.full`, the k8s-ha arms,
 *   `.fan` and `setupFan` (`pullFan` is NOT here: it is serial work on the
 *   critical path and must be nameable), and the image delta, which runs
 *   inside `image.transfer` (compose, once per compose-ha server) or
 *   `image.deliver` (k8s);
 * - work that runs in the background, whose residue on the critical path has
 *   its own `.await` marker or overlaps a later step: the base pulls, the
 *   compose stack pull (stackPull.await), the compose image transfer
 *   (transfer.await, and compose-ha's imageTransfer.await) and k8s-ha's early
 *   replication transport;
 * - the Pulumi breakdown inside an iac.upStack marker (`.prepare`, `.resource.*`:
 *   the select/refresh before `up`, and each resource's own time, which sum
 *   to more than the wall clock when resources run in parallel);
 * - markers nested inside another or outside `deploy.total`: the state seed
 *   inside `deploy.preamble.s3Setup`, and `deploy.preamble.subscription`,
 *   which runs while config is gathered, before `deploy.total` starts;
 * - the first-boot breakdown (`deploy.<prefix>.boot.*`, read back from each
 *   node after its ready wait): it splits time the ready wait already holds.
 */
const NOT_SERIAL =
  /^(cli\.)?deploy\.total$|\.full$|^deploy\.ha\.k8s\.(primary|standby)$|\.fan$|setupFan$|\.iac\.upStack(\.(primary|standby))?\.(prepare|resource\..+)$|^deploy\.preamble\.(s3Setup\.stateSeed|subscription)$|^deploy\.image\.delta$|\.basePull$|^deploy\.compose\.imagesPull$|^deploy\.image\.transfer$|^deploy\.ha\.replication\.transportEarly$|\.boot\./;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI = /\x1b\[[0-9;]*m/g;
const STATE_UP =
  /\[state\] up (\S+): .*?\| backpressure (.+?) \| lock-waits (\d+)(?: \((\d+)s\))?/g;

export interface DeployBudgetResult extends VerificationResult {
  ok: boolean;
  /** The verdict in one line: the failures, or the numbers that passed. */
  message: string;
}

const s = (ms: number) => Math.round(ms / 1000);

/**
 * `deploy_budget` for one cold deploy. `output` is the deploy's combined
 * stdout and stderr (VIBECARBON_PERF=1).
 */
export function checkDeployBudget(
  output: string,
  mode: DeployMode,
  key: BudgetKey,
  table: BudgetTable = DEPLOY_BUDGET_TABLE,
): DeployBudgetResult {
  const checkName = 'deploy_budget';
  const budget = budgetFor(table, mode, key);
  const clean = output.replace(ANSI, '');
  const perf = parsePerfLines(clean);
  const all = (name: string) => perf.filter((p) => p.name === name);
  const failures: string[] = [];

  const totals = all('deploy.total');
  const totalMs = totals.length ? Math.max(...totals.map((p) => p.ms)) : null;
  const tlsMs = [...all('deploy.tls.ready'), ...all('deploy.tls.snapshot')].reduce(
    (sum, p) => sum + p.ms,
    0,
  );
  const ownedMs = totalMs === null ? null : totalMs - tlsMs;
  if (!budget) {
    failures.push(
      `no budget yet for ${key.provider}/${mode}/${key.cpuClass}: no passing cold deploy calibrated it ` +
        '(scripts/calibrate-deploy-budgets.js writes the row after one)',
    );
  }
  if (totalMs === null || ownedMs === null) {
    failures.push(
      'no [perf] deploy.total marker (VIBECARBON_PERF off, or the deploy never reached its outro)',
    );
  } else if (budget) {
    if (s(ownedMs) > budget.ownedS) {
      failures.push(
        `deploy-owned ${s(ownedMs)}s > ${budget.ownedS}s (deploy.total ${s(totalMs)}s − TLS first look ${s(tlsMs)}s)`,
      );
    }
    if (s(totalMs) > budget.endToEndS) {
      failures.push(`end-to-end ${s(totalMs)}s > ${budget.endToEndS}s`);
    }
  }

  // Cold image bytes.
  const deltaBytes = all('deploy.image.delta')
    .map((p) => /\bbytes=(\d+)/.exec(p.note ?? '')?.[1])
    .filter((b): b is string => b !== undefined)
    .map(Number);
  if (DELTA_MODES.has(mode)) {
    const expected = DELTA_MARKERS[mode] ?? 1;
    if (deltaBytes.length === 0) {
      failures.push(
        'no [perf] deploy.image.delta bytes= marker, so the cold image bytes are unread',
      );
    } else if (deltaBytes.length < expected) {
      failures.push(
        `${deltaBytes.length} [perf] deploy.image.delta marker, expected ${expected} (one per server)`,
      );
    }
    for (const bytes of deltaBytes) {
      if (bytes > COLD_DELTA_MAX_BYTES) {
        failures.push(
          `cold image delta ${(bytes / 1_000_000).toFixed(1)} MB > ${COLD_DELTA_MAX_BYTES / 1_000_000} MB`,
        );
      }
    }
  }

  // HA state-lock invariants.
  const ha = mode === 'compose-ha' || mode === 'k8s-ha';
  let lockWaitS: number | null = null;
  if (ha) {
    const states = [...clean.matchAll(STATE_UP)];
    if (states.length === 0) {
      failures.push('no [state] up line, so the state-lock invariants are unread');
    }
    for (const [, stack, backpressure] of states) {
      if (backpressure.trim() !== 'none') {
        failures.push(`state backpressure ${backpressure.trim()} on up ${stack}`);
      }
    }
    // The counters are cumulative per process: the largest is the total.
    if (states.length > 0) {
      lockWaitS = Math.max(...states.map((m) => Number(m[4] ?? 0)));
      if (lockWaitS > HA_LOCK_WAIT_MAX_S) {
        failures.push(`lock wait ${lockWaitS}s > ${HA_LOCK_WAIT_MAX_S}s`);
      }
    }
  }

  if (mode === 'compose-ha') {
    const one = (name: string) => all(name)[0]?.ms;
    const fan = one('deploy.ha.compose.iac.upStack.fan');
    const primary = one('deploy.ha.compose.iac.upStack.primary');
    const standby = one('deploy.ha.compose.iac.upStack.standby');
    if (fan === undefined || primary === undefined || standby === undefined) {
      failures.push(
        'no [perf] deploy.ha.compose.iac.upStack.fan/primary/standby markers, so the fan ratio is unread',
      );
    } else {
      const ceiling = FAN_RATIO_MAX * Math.max(primary, standby);
      if (fan > ceiling) {
        failures.push(
          `iac.upStack.fan ${s(fan)}s > ${FAN_RATIO_MAX} × max(primary ${s(primary)}s, standby ${s(standby)}s) = ${s(ceiling)}s`,
        );
      }
    }
  }

  if (mode === 'k8s-ha') {
    const awaitDb = all('deploy.k3s.standby.awaitDb');
    if (awaitDb.length === 0) {
      failures.push('no [perf] deploy.k3s.standby.awaitDb marker');
    } else if (Math.max(...awaitDb.map((p) => p.ms)) >= STANDBY_AWAIT_DB_MAX_MS) {
      const ms = Math.max(...awaitDb.map((p) => p.ms));
      failures.push(`deploy.k3s.standby.awaitDb ${s(ms)}s ≥ ${s(STANDBY_AWAIT_DB_MAX_MS)}s`);
    }
    const transport = all('deploy.ha.replication.transportEarly');
    if (transport.length === 0) {
      failures.push('no [perf] deploy.ha.replication.transportEarly marker');
    } else if (transport.some((p) => p.note?.includes('(failed)'))) {
      failures.push('deploy.ha.replication.transportEarly (failed)');
    }
  }

  // parsePerfLines sorts slowest first.
  const slowest = perf
    .filter((p) => !NOT_SERIAL.test(p.name))
    .slice(0, 3)
    .map((p) => `${p.name} ${s(p.ms)}s`);
  const details = {
    mode,
    provider: key.provider,
    cpuClass: key.cpuClass,
    totalS: totalMs === null ? null : s(totalMs),
    tlsFirstLookS: s(tlsMs),
    ownedS: ownedMs === null ? null : s(ownedMs),
    ownedBudgetS: budget?.ownedS ?? null,
    endToEndBudgetS: budget?.endToEndS ?? null,
    deltaBytes,
    lockWaitS,
    slowest,
  };

  if (failures.length > 0) {
    const cause = slowest.length ? ` | slowest: ${slowest.join(', ')}` : '';
    const message = `${failures.join('; ')}${cause}`;
    return { checkName, status: 'fail', ok: false, message, errorMessage: message, details };
  }
  const message =
    `deploy-owned ${details.ownedS}s ≤ ${budget?.ownedS}s, ` +
    `end-to-end ${details.totalS}s ≤ ${budget?.endToEndS}s`;
  return { checkName, status: 'pass', ok: true, message, details };
}
