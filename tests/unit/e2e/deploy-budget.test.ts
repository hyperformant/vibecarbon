/**
 * Per-mode cold-deploy budgets (tests/e2e/checks/deploy-budget.ts), against
 * fixture deploy logs shaped like the CLI's real output: `[perf]` lines on
 * stderr, the `[state]` summary inside a clack log line.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type BudgetKey,
  type BudgetTable,
  budgetFor,
  DEPLOY_BUDGET_TABLE,
  deployCpuClass,
  checkDeployBudget as judge,
} from '../../e2e/checks/deploy-budget.js';
import type { DeployMode } from '../../e2e/scenarios/types.js';

/** The numbers these fixtures are bent around (one provider, one class). */
const TABLE: BudgetTable = {
  hetzner: {
    compose: { cx: { ownedS: 180, endToEndS: 300, samples: 9 } },
    'compose-ha': { cx: { ownedS: 300, endToEndS: 360, samples: 9 } },
    k8s: { cx: { ownedS: 300, endToEndS: 390, samples: 9 } },
    'k8s-ha': { cx: { ownedS: 420, endToEndS: 480, samples: 9 } },
  },
};
const KEY: BudgetKey = { provider: 'hetzner', cpuClass: 'cx' };
const checkDeployBudget = (output: string, mode: DeployMode, key = KEY, table = TABLE) =>
  judge(output, mode, key, table);

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
function fixture(mode: DeployMode, o: LogOpts = {}): string {
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
      // One local build, one delta per server, overlapping the setup fan.
      perf('deploy.image.basePull', 15_000),
      perf('deploy.image.basePull', 17_000),
      ...delta(o.deltaBytes),
      ...delta(o.deltaBytes),
      perf('deploy.image.transfer', 22_000),
      perf('deploy.image.transfer', 25_000),
      perf('deploy.ha.compose.imageTransfer.fan', 25_000),
      perf('deploy.ha.compose.imageTransfer.await', 1_000),
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

describe('budgets are keyed on provider + mode + class', () => {
  it('judges each key against its own row', () => {
    const table: BudgetTable = {
      hetzner: { compose: { cx: { ownedS: 180, endToEndS: 300, samples: 9 } } },
      digitalocean: {
        compose: {
          amd: { ownedS: 120, endToEndS: 135, samples: 9 },
          intel: { ownedS: 400, endToEndS: 415, samples: 9 },
        },
      },
    };
    const log = fixture('compose', { total: 250_000, tlsReady: 5_000, tlsSnapshot: 0 });
    // 245 s owned: over DO amd's 120, inside DO intel's 400, over Hetzner cx's 180.
    const run = (provider: string, cpuClass: string) =>
      judge(log, 'compose', { provider, cpuClass }, table);
    expect(run('digitalocean', 'amd').message).toMatch(/deploy-owned 245s > 120s/);
    expect(run('digitalocean', 'intel').ok).toBe(true);
    expect(run('hetzner', 'cx').message).toMatch(/deploy-owned 245s > 180s/);
  });

  it('a combination with no row fails with `no budget yet`, never a pass', () => {
    for (const key of [
      { provider: 'hetzner', cpuClass: 'ccx' }, // class with no data
      { provider: 'vultr', cpuClass: 'cx' }, // provider with no data
    ]) {
      const r = checkDeployBudget(fixture('compose'), 'compose', key);
      expect(r.ok).toBe(false);
      expect(r.status).toBe('fail');
      expect(r.message).toMatch(
        new RegExp(`no budget yet for ${key.provider}/compose/${key.cpuClass}`),
      );
    }
    expect(checkDeployBudget(fixture('k8s'), 'k8s', KEY, {}).message).toMatch(/no budget yet/);
  });

  it('still judges the byte and lock invariants when the time budget is missing', () => {
    const r = checkDeployBudget(fixture('compose-ha', { standbyLock: '1 (93s)' }), 'compose-ha', {
      provider: 'vultr',
      cpuClass: 'vc2',
    });
    expect(r.message).toMatch(/no budget yet/);
    expect(r.message).toMatch(/lock wait 93s > 15s/);
  });

  it('records the key it judged', () => {
    const r = checkDeployBudget(fixture('compose'), 'compose');
    expect(r.details).toMatchObject({ provider: 'hetzner', cpuClass: 'cx' });
  });

  it('the calibrated table has no hand-edit shape errors', () => {
    for (const [provider, modes] of Object.entries(DEPLOY_BUDGET_TABLE)) {
      for (const [mode, classes] of Object.entries(modes)) {
        for (const [cpuClass, row] of Object.entries(classes)) {
          const where = `${provider}/${mode}/${cpuClass}`;
          expect(row.ownedS % 5, where).toBe(0);
          expect(row.endToEndS, where).toBeGreaterThanOrEqual(row.ownedS + 15);
          expect(row.samples, where).toBeGreaterThan(0);
          expect(budgetFor(DEPLOY_BUDGET_TABLE, mode as DeployMode, { provider, cpuClass })).toBe(
            row,
          );
        }
      }
    }
  });
});

describe('deployCpuClass', () => {
  it('names the class of the recorded server type', () => {
    expect(deployCpuClass('hetzner', 'cx32')).toBe('cx');
    expect(deployCpuClass('hetzner', 'cpx31')).toBe('cpx');
    expect(deployCpuClass('digitalocean', 's-2vcpu-4gb-intel')).toBe('intel');
  });

  it('is `standard` for a provider that declares no classes', () => {
    expect(deployCpuClass('linode', 'g6-standard-2')).toBe('standard');
    expect(deployCpuClass('linode', undefined)).toBe('standard');
  });

  it('is `unknown` for a classed provider whose type is missing or classless', () => {
    expect(deployCpuClass('hetzner', undefined)).toBe('unknown');
    expect(deployCpuClass('hetzner', 'not-a-type')).toBe('unknown');
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
      /slowest: deploy\.iac\.upStack 70s, deploy\.compose\.stackPull\.await 9s, deploy\.tls\.ready 5s/,
    );
  });

  it('leaves background and umbrella markers out of the slowest list', () => {
    const compose = checkDeployBudget(fixture('compose', { total: 400_000 }), 'compose');
    expect(compose.message).not.toMatch(/basePull|image\.delta|image\.transfer /);
    const ha = checkDeployBudget(fixture('k8s-ha', { total: 600_000 }), 'k8s-ha');
    expect(ha.message).not.toMatch(/transportEarly|deploy\.ha\.k8s\.full|image\.delta/);
    const cha = checkDeployBudget(fixture('compose-ha', { total: 600_000 }), 'compose-ha');
    expect(cha.message).not.toMatch(
      /\.fan |deploy\.ha\.compose\.full|image\.delta|image\.transfer |basePull/,
    );
    expect(cha.message).toMatch(/slowest: deploy\.ha\.compose\.iac\.upStack\.standby 100s/);
  });

  it('leaves the first-boot breakdown out of the slowest list (it splits a ready wait)', () => {
    const log = `${fixture('compose', { total: 400_000 })}\n[perf] deploy.compose.boot.cloudInit.total 900000ms\n`;
    const r = checkDeployBudget(log, 'compose');
    expect(r.message).not.toMatch(/\.boot\./);
    expect(r.message).toMatch(/slowest: deploy\.tls\.ready 90s, deploy\.iac\.upStack 70s/);
  });

  it('leaves the CLI total, Pulumi breakdown and nested preamble markers out of the slowest list', () => {
    const extra = [
      '[perf] cli.deploy.total 999000ms',
      '[perf] deploy.iac.upStack.prepare 800000ms',
      '[perf] deploy.iac.upStack.resource.Server.web 700000ms',
      '[perf] deploy.k3s.primary.iac.upStack.resource.Firewall.fw 600000ms',
      '[perf] deploy.preamble.s3Setup.stateSeed 500000ms',
      '[perf] deploy.preamble.subscription 400000ms',
    ].join('\n');
    const r = checkDeployBudget(`${fixture('compose', { total: 400_000 })}\n${extra}\n`, 'compose');
    expect(r.message).not.toMatch(
      /cli\.deploy\.total|\.prepare|\.resource\.|stateSeed|subscription/,
    );
    expect(r.message).toMatch(/slowest: deploy\.tls\.ready 90s, deploy\.iac\.upStack 70s/);
  });

  it('names serial preamble and pullFan markers among the slowest', () => {
    const extra = [
      '[perf] deploy.ha.compose.pullFan 900000ms',
      '[perf] deploy.preamble.s3Setup 800000ms',
    ].join('\n');
    const r = checkDeployBudget(`${fixture('compose', { total: 400_000 })}\n${extra}\n`, 'compose');
    expect(r.message).toMatch(
      /slowest: deploy\.ha\.compose\.pullFan 900s, deploy\.preamble\.s3Setup 800s/,
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
  it('fails compose-ha with a delta marker for only one of its two servers', () => {
    const log = fixture('compose-ha').replace(/^\[perf\] deploy\.image\.delta .*\n/m, '');
    expect(log.match(/deploy\.image\.delta /g)).toHaveLength(1);
    const r = checkDeployBudget(log, 'compose-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(
      /1 \[perf\] deploy\.image\.delta marker, expected 2 \(one per server\)/,
    );
  });

  it.each(['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const)(
    'fails %s with a delta over 10 MB',
    (mode) => {
      const r = checkDeployBudget(fixture(mode, { deltaBytes: 12_300_000 }), mode);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/cold image delta 12\.3 MB > 10 MB/);
    },
  );

  it.each(['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const)(
    'fails %s with no delta marker',
    (mode) => {
      const r = checkDeployBudget(fixture(mode, { deltaBytes: null }), mode);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no \[perf\] deploy\.image\.delta bytes/);
    },
  );
});

describe('checkDeployBudget: HA invariants', () => {
  it('judges the lock wait and the fan ratio on every cold deploy', () => {
    const r = checkDeployBudget(
      fixture('compose-ha', { standbyLock: '1 (93s)', fan: 200_000 }),
      'compose-ha',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lock wait 93s > 15s/);
    expect(r.message).toMatch(/iac\.upStack\.fan 200s/);
  });

  it('fails a compose-ha cold deploy whose standby waited on the lock', () => {
    const r = checkDeployBudget(fixture('compose-ha', { standbyLock: '1 (93s)' }), 'compose-ha');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lock wait 93s > 15s/);
  });

  it('passes a lock wait of exactly 15s, the alarm line', () => {
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
