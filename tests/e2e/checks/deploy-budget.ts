/**
 * Per-mode cold-deploy budgets, judged from the deploy's own CLI log.
 *
 * A cold deploy (the e2e db's classifyColdWarm: no passing deploy for the
 * project and env in 24 h, which is every scenario's first deploy) must fit
 * two budgets (ruling D1):
 *
 * - DEPLOY-OWNED: `deploy.total` minus the TLS first look (`deploy.tls.ready`
 *   plus `deploy.tls.snapshot`), the work the deploy controls. A first-ever
 *   deploy waits up to 180 s for Let's Encrypt; that wait is the CA's, not ours.
 * - END-TO-END: `deploy.total` itself, a first-ever deploy with TLS issued.
 *
 * `deploy.total` starts when executeDeployment does (after config gathering
 * and the local preflight) and ends at the success outro.
 *
 * Hard limits, no uplink exemption: the cold image delta's bytes are asserted
 * too (10 MB), so a slow uplink moves a deploy by seconds, not minutes. If
 * real runs miss, the budgets are recalibrated from data, never loosened
 * silently.
 *
 * HA cold deploys also hold the state-lock invariants (ruling R6b): no
 * `backpressure` in any `[state] up` line, and a lock wait of at most 15 s
 * (select and refresh still serialize, so the second engine always waits a
 * little). compose-ha's infra fan must stay within 1.25x its slower arm.
 * Inside a young state bucket (the deploy prints `[state] scope young`,
 * Ruling A′) the whole upStack is locked, so those two are not judged and the
 * details say why; backpressure still is.
 * k8s-ha's standby must not wait on its database for a minute, and the early
 * replication transport must not fail.
 *
 * Never a hollow pass: a log without the markers a judgement rests on fails
 * (tests/unit/e2e/hollow-pass-census.test.ts registers this check). A failure
 * names the three slowest markers, so the message says where the time went.
 */
import { parsePerfLines } from '../metrics/reporter.js';
import type { DeployMode, VerificationResult } from '../scenarios/types.js';

/** Seconds, per mode (D1). */
export const DEPLOY_BUDGETS: Record<DeployMode, { ownedS: number; endToEndS: number }> = {
  compose: { ownedS: 180, endToEndS: 300 },
  'compose-ha': { ownedS: 300, endToEndS: 360 },
  k8s: { ownedS: 300, endToEndS: 390 },
  'k8s-ha': { ownedS: 420, endToEndS: 480 },
};

/** A cold image delta carries the app's own layers on a pulled base: 4-5 MB. */
export const COLD_DELTA_MAX_BYTES = 10_000_000;
/** One select plus one refresh of the other engine (R6b). */
export const HA_LOCK_WAIT_MAX_S = 15;
export const FAN_RATIO_MAX = 1.25;
export const STANDBY_AWAIT_DB_MAX_MS = 60_000;

/** Modes whose app image reaches the server by layer delta (deliverImage). */
const DELTA_MODES: ReadonlySet<DeployMode> = new Set(['compose', 'k8s', 'k8s-ha']);

/**
 * Markers that are not serial work of their own, kept out of the "slowest"
 * list a failure names:
 * - umbrellas that wrap other markers: the total, `.full`, the k8s-ha arms,
 *   every fan (`.fan`, `setupFan`, `pullFan`), and the image delta, which runs
 *   inside `image.transfer` (compose) or `image.deliver` (k8s);
 * - work that runs in the background, whose residue on the critical path has
 *   its own `.await` marker or overlaps a later step: the base pulls, the
 *   compose stack pull (stackPull.await), the compose image transfer
 *   (transfer.await) and k8s-ha's early replication transport.
 */
const NOT_SERIAL =
  /^deploy\.total$|\.full$|^deploy\.ha\.k8s\.(primary|standby)$|\.fan$|Fan$|^deploy\.image\.delta$|\.basePull$|^deploy\.compose\.imagesPull$|^deploy\.image\.transfer$|^deploy\.ha\.replication\.transportEarly$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI = /\x1b\[[0-9;]*m/g;
/**
 * The deploy's Ruling A′ line (src/lib/iac/state-telemetry.js
 * formatStateScopeYoung): the state bucket is inside its provider's settle
 * window, so each upStack holds the lock end to end and the HA pair's ups
 * serialize by design.
 */
export const STATE_SCOPE_YOUNG = /\[state\] scope young (\S+)/;
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
export function checkDeployBudget(output: string, mode: DeployMode): DeployBudgetResult {
  const checkName = 'deploy_budget';
  const budget = DEPLOY_BUDGETS[mode];
  const clean = output.replace(ANSI, '');
  const perf = parsePerfLines(clean);
  const all = (name: string) => perf.filter((p) => p.name === name);
  const failures: string[] = [];

  if (!budget) {
    const message = `no cold-deploy budget for mode ${mode}`;
    return { checkName, status: 'fail', ok: false, message, errorMessage: message };
  }

  const totals = all('deploy.total');
  const totalMs = totals.length ? Math.max(...totals.map((p) => p.ms)) : null;
  const tlsMs = [...all('deploy.tls.ready'), ...all('deploy.tls.snapshot')].reduce(
    (sum, p) => sum + p.ms,
    0,
  );
  const ownedMs = totalMs === null ? null : totalMs - tlsMs;
  if (totalMs === null || ownedMs === null) {
    failures.push(
      'no [perf] deploy.total marker (VIBECARBON_PERF off, or the deploy never reached its outro)',
    );
  } else {
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
    if (deltaBytes.length === 0) {
      failures.push(
        'no [perf] deploy.image.delta bytes= marker, so the cold image bytes are unread',
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

  // HA state-lock invariants. Inside a young state bucket the whole upStack
  // is locked (Ruling A′), so the second engine waits out the first one's up
  // and the fan runs near the sum of its arms: the lock-wait and fan checks
  // only hold past the window. Backpressure is judged either way.
  const youngStateBucket = STATE_SCOPE_YOUNG.exec(clean)?.[1] ?? null;
  const ha = mode === 'compose-ha' || mode === 'k8s-ha';
  const skipped =
    ha && youngStateBucket
      ? `lock wait and fan ratio not judged: state bucket ${youngStateBucket} was inside its settle window, so each up held the state lock end to end`
      : null;
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
      if (!youngStateBucket && lockWaitS > HA_LOCK_WAIT_MAX_S) {
        failures.push(`lock wait ${lockWaitS}s > ${HA_LOCK_WAIT_MAX_S}s`);
      }
    }
  }

  if (mode === 'compose-ha' && !youngStateBucket) {
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
    totalS: totalMs === null ? null : s(totalMs),
    tlsFirstLookS: s(tlsMs),
    ownedS: ownedMs === null ? null : s(ownedMs),
    ownedBudgetS: budget.ownedS,
    endToEndBudgetS: budget.endToEndS,
    deltaBytes,
    lockWaitS,
    youngStateBucket,
    skipped,
    slowest,
  };

  if (failures.length > 0) {
    const cause = slowest.length ? ` | slowest: ${slowest.join(', ')}` : '';
    const message = `${failures.join('; ')}${cause}`;
    return { checkName, status: 'fail', ok: false, message, errorMessage: message, details };
  }
  const message =
    `deploy-owned ${details.ownedS}s ≤ ${budget.ownedS}s, ` +
    `end-to-end ${details.totalS}s ≤ ${budget.endToEndS}s`;
  return { checkName, status: 'pass', ok: true, message, details };
}
