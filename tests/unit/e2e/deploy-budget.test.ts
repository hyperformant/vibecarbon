/**
 * Per-mode cold-deploy budgets (tests/e2e/checks/deploy-budget.ts), against
 * fixture deploy logs shaped like the CLI's real output: `[perf]` lines on
 * stderr, the `[state]` summary inside a clack log line.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkDeployBudget, DEPLOY_BUDGETS } from '../../e2e/checks/deploy-budget.js';

const perf = (name: string, ms: number, note?: string) =>
  `[perf] ${name} ${ms}ms${note ? ` ${note}` : ''}`;
const state = (stack: string, backpressure: string, lockWaits: string) =>
  `●  [state] up ${stack}: ops up=2 stack-select=1 | backpressure ${backpressure} | ` +
  `lock-waits ${lockWaits} | documented ceilings (hetzner): none published`;

interface LogOpts {
  total?: number;
  tlsReady?: number;
  tlsSnapshot?: number;
  deltaBytes?: number | null;
  standbyLock?: string;
  standbyBackpressure?: string;
  fan?: number;
  awaitDb?: number | null;
  transportNote?: string;
  transport?: boolean;
  state?: boolean;
}

/** A passing cold deploy log for each mode; opts bend one number. */
function fixture(mode: keyof typeof DEPLOY_BUDGETS, o: LogOpts = {}): string {
  const lines: string[] = ['◇  Provisioning infrastructure', 'some spinner text'];
  const delta = (bytes: number | null | undefined) =>
    bytes === null
      ? []
      : [perf('deploy.image.delta', 21_000, `bytes=${bytes ?? 4_800_000} sent=3 reused=9`)];
  if (mode === 'compose') {
    lines.push(
      perf('deploy.iac.upStack', 70_000),
      perf('deploy.image.basePull', 18_000),
      ...delta(o.deltaBytes),
      perf('deploy.image.transfer', 24_000),
      perf('deploy.compose.stackPull.await', 9_000),
      perf('deploy.compose.imagesPull', 120_000),
      perf('deploy.tls.ready', o.tlsReady ?? 90_000),
      perf('deploy.tls.snapshot', o.tlsSnapshot ?? 3_000),
      perf('deploy.storage.finish', 1_200),
      perf('deploy.total', o.total ?? 250_000),
    );
  } else if (mode === 'compose-ha') {
    lines.push(
      perf('deploy.ha.compose.iac.upStack.primary', 95_000),
      ...(o.state === false
        ? []
        : [
            state('e2-primary', 'none', '0'),
            state('e2-standby', o.standbyBackpressure ?? 'none', o.standbyLock ?? '1 (8s)'),
          ]),
      perf('deploy.ha.compose.iac.upStack.standby', 100_000),
      perf('deploy.ha.compose.iac.upStack.fan', o.fan ?? 101_000),
      perf('deploy.ha.compose.remoteBuild.fan', 80_000),
      perf('deploy.tls.ready', o.tlsReady ?? 50_000),
      perf('deploy.ha.compose.full', 280_000),
      perf('deploy.total', o.total ?? 340_000),
    );
  } else if (mode === 'k8s') {
    lines.push(
      perf('deploy.k3s.iac.upStack', 96_000),
      perf('deploy.k3s.certManager.wait', 36_000),
      ...delta(o.deltaBytes),
      perf('deploy.k3s.image.deliver', 30_000),
      perf('deploy.k3s.applyBase', 30_000),
      perf('deploy.k3s.full', 260_000),
      perf('deploy.tls.ready', o.tlsReady ?? 85_000),
      perf('deploy.total', o.total ?? 380_000),
    );
  } else {
    lines.push(
      perf('deploy.k3s.primary.iac.upStack', 100_000),
      ...(o.state === false
        ? []
        : [
            state('e4-primary', 'none', '0'),
            state('e4-standby', o.standbyBackpressure ?? 'none', o.standbyLock ?? '1 (6s)'),
          ]),
      perf('deploy.k3s.standby.iac.upStack', 98_000),
      ...delta(o.deltaBytes),
      perf('deploy.k3s.primary.image.deliver', 30_000),
      ...(o.awaitDb === null ? [] : [perf('deploy.k3s.standby.awaitDb', o.awaitDb ?? 20_000)]),
      ...(o.transport === false
        ? []
        : [perf('deploy.ha.replication.transportEarly', 15_000, o.transportNote)]),
      perf('deploy.ha.image.copyToStandby', 25_000),
      perf('deploy.ha.k8s.full', 380_000),
      perf('deploy.tls.ready', o.tlsReady ?? 60_000),
      perf('deploy.total', o.total ?? 470_000),
    );
  }
  lines.push('◆  Deployment to e1 complete! (4m 10s)');
  return lines.join('\n');
}

describe('DEPLOY_BUDGETS', () => {
  it('holds the D1 numbers: deploy-owned and end-to-end seconds per mode', () => {
    expect(DEPLOY_BUDGETS).toEqual({
      compose: { ownedS: 180, endToEndS: 300 },
      'compose-ha': { ownedS: 300, endToEndS: 360 },
      k8s: { ownedS: 300, endToEndS: 390 },
      'k8s-ha': { ownedS: 420, endToEndS: 480 },
    });
  });
});

describe('checkDeployBudget: each mode passes inside its budgets', () => {
  it.each(['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const)('%s', (mode) => {
    const r = checkDeployBudget(fixture(mode), mode);
    expect(r.message).not.toMatch(/>/);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('pass');
    expect(r.checkName).toBe('deploy_budget');
  });

  it('records the numbers it judged', () => {
    const r = checkDeployBudget(fixture('compose'), 'compose');
    expect(r.details).toMatchObject({
      mode: 'compose',
      totalS: 250,
      tlsFirstLookS: 93,
      ownedS: 157,
      ownedBudgetS: 180,
      endToEndBudgetS: 300,
      deltaBytes: [4_800_000],
    });
  });

  it('does not count the background compose imagesPull among the slowest markers', () => {
    const r = checkDeployBudget(fixture('compose', { total: 400_000 }), 'compose');
    expect(r.message).not.toMatch(/imagesPull/);
    expect(r.message).toMatch(/deploy\.iac\.upStack 70s/);
  });
});

describe('checkDeployBudget: time budgets', () => {
  const cases = [
    // owned only: total - TLS over, total itself inside end-to-end
    ['compose', { total: 290_000, tlsReady: 5_000, tlsSnapshot: 0 }, /deploy-owned 285s > 180s/],
    ['compose-ha', { total: 350_000, tlsReady: 10_000 }, /deploy-owned 340s > 300s/],
    ['k8s', { total: 385_000, tlsReady: 20_000 }, /deploy-owned 365s > 300s/],
    ['k8s-ha', { total: 470_000, tlsReady: 30_000 }, /deploy-owned 440s > 420s/],
    // end-to-end only: owned inside, total over
    ['compose', { total: 310_000, tlsReady: 200_000 }, /end-to-end 310s > 300s/],
    ['compose-ha', { total: 370_000, tlsReady: 100_000 }, /end-to-end 370s > 360s/],
    ['k8s', { total: 400_000, tlsReady: 150_000 }, /end-to-end 400s > 390s/],
    ['k8s-ha', { total: 490_000, tlsReady: 100_000 }, /end-to-end 490s > 480s/],
  ] as const;

  it.each(cases)('fails %s %o', (mode, opts, re) => {
    const r = checkDeployBudget(fixture(mode, opts), mode);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(re);
    expect(r.errorMessage).toBe(r.message);
  });

  it('names the top three serial markers when time blows the budget', () => {
    const r = checkDeployBudget(fixture('compose', { total: 400_000, tlsReady: 5_000 }), 'compose');
    expect(r.message).toMatch(
      /slowest: deploy\.iac\.upStack 70s, deploy\.image\.transfer 24s, deploy\.image\.delta 21s/,
    );
  });

  it('fails a log with no deploy.total marker (the check cannot run)', () => {
    const log = fixture('compose').replace(/^\[perf\] deploy\.total .*$/m, '');
    const r = checkDeployBudget(log, 'compose');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no \[perf\] deploy\.total marker/);
  });

  it('fails an empty log', () => {
    expect(checkDeployBudget('', 'k8s').ok).toBe(false);
  });
});

describe('checkDeployBudget: cold image bytes', () => {
  it.each(['compose', 'k8s', 'k8s-ha'] as const)('fails %s with a delta over 10 MB', (mode) => {
    const r = checkDeployBudget(fixture(mode, { deltaBytes: 12_300_000 }), mode);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cold image delta 12\.3 MB > 10 MB/);
  });

  it.each(['compose', 'k8s', 'k8s-ha'] as const)('fails %s with no delta marker', (mode) => {
    const r = checkDeployBudget(fixture(mode, { deltaBytes: null }), mode);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no \[perf\] deploy\.image\.delta bytes/);
  });

  it('does not ask compose-ha (remote build) for a delta', () => {
    expect(checkDeployBudget(fixture('compose-ha'), 'compose-ha').ok).toBe(true);
  });
});

describe('checkDeployBudget: HA invariants', () => {
  it('fails a compose-ha cold deploy whose standby waited on the lock', () => {
    const r = checkDeployBudget(fixture('compose-ha', { standbyLock: '1 (93s)' }), 'compose-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lock wait 93s > 15s/);
  });

  it('passes a lock wait of exactly 15s (a select plus refresh)', () => {
    const r = checkDeployBudget(fixture('k8s-ha', { standbyLock: '2 (15s)' }), 'k8s-ha');
    expect(r.ok).toBe(true);
  });

  it.each(['compose-ha', 'k8s-ha'] as const)('fails %s on any state backpressure', (mode) => {
    const r = checkDeployBudget(fixture(mode, { standbyBackpressure: 'up=2' }), mode);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/state backpressure up=2/);
  });

  it.each(['compose-ha', 'k8s-ha'] as const)('fails %s with no [state] up line', (mode) => {
    const r = checkDeployBudget(fixture(mode, { state: false }), mode);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no \[state\] up line/);
  });

  it('fails compose-ha whose upStack fan ran past 1.25x its slower arm', () => {
    const r = checkDeployBudget(fixture('compose-ha', { fan: 140_000 }), 'compose-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(
      /iac\.upStack\.fan 140s > 1\.25 × max\(primary 95s, standby 100s\) = 125s/,
    );
  });

  it('fails compose-ha with no upStack fan markers', () => {
    const log = fixture('compose-ha').replace(
      /^\[perf\] deploy\.ha\.compose\.iac\.upStack\.fan .*$/m,
      '',
    );
    const r = checkDeployBudget(log, 'compose-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no \[perf\] deploy\.ha\.compose\.iac\.upStack\.fan/);
  });

  it('fails k8s-ha whose standby waited 60s on the database', () => {
    const r = checkDeployBudget(fixture('k8s-ha', { awaitDb: 60_000 }), 'k8s-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/deploy\.k3s\.standby\.awaitDb 60s ≥ 60s/);
  });

  it('fails k8s-ha with no standby awaitDb marker', () => {
    const r = checkDeployBudget(fixture('k8s-ha', { awaitDb: null }), 'k8s-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no \[perf\] deploy\.k3s\.standby\.awaitDb/);
  });

  it('fails k8s-ha whose early replication transport failed', () => {
    const r = checkDeployBudget(fixture('k8s-ha', { transportNote: '(failed)' }), 'k8s-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/deploy\.ha\.replication\.transportEarly \(failed\)/);
  });

  it('fails k8s-ha with no early replication transport marker', () => {
    const r = checkDeployBudget(fixture('k8s-ha', { transport: false }), 'k8s-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no \[perf\] deploy\.ha\.replication\.transportEarly/);
  });

  it('does not apply HA invariants to single-cluster modes', () => {
    // A compose deploy has one engine: no [state] line requirement.
    expect(checkDeployBudget(fixture('compose'), 'compose').ok).toBe(true);
  });

  it('strips ANSI colour from the state line before reading it', () => {
    const log = fixture('compose-ha', { standbyLock: '1 (93s)' }).replace(
      /\[state\]/g,
      '\x1b[2m[state]\x1b[22m',
    );
    expect(checkDeployBudget(log, 'compose-ha').message).toMatch(/lock wait 93s > 15s/);
  });
});

describe('the markers the budget reads exist in the deploy', () => {
  const orch = readFileSync('src/lib/deploy/orchestrator.js', 'utf8');

  it('deploy.total runs from executeDeployment start to the success outro', () => {
    const start = orch.indexOf('export async function executeDeployment');
    const timer = orch.indexOf("perfTimer('deploy.total')");
    const end = orch.indexOf('deployTotalTimer.end()');
    const outro = orch.indexOf('complete! ${c.dim');
    expect(start).toBeGreaterThan(-1);
    expect(timer).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(timer);
    expect(end).toBeLessThan(outro);
  });

  it('deploy.storage.finish wraps the app-bucket finalize', () => {
    expect(orch).toMatch(
      /perfAsync\('deploy\.storage\.finish',\s*\(\) =>\s*appBucketFinalize\.finish\(p\.log\),?\s*\)/,
    );
  });
});
