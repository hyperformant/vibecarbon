import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  addSeeds,
  budgetFromSamples,
  buildTable,
  ceil5,
  percentile,
  readSamples,
  renderReport,
  seededRow,
} from '../../../scripts/calibrate-deploy-budgets.js';
import { createTempDir } from '../../_shared/temp-dir.js';
import { checkDeployBudget } from '../../e2e/checks/deploy-budget.js';

const s = (ownedS: number, tlsS = 5) => ({ ownedS, tlsS });

describe('the budget rule', () => {
  it('ceil5 rounds up to a multiple of 5', () => {
    expect([ceil5(0), ceil5(1), ceil5(5), ceil5(5.01), ceil5(212)]).toEqual([0, 5, 5, 10, 215]);
  });

  it('the median is nearest-rank', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
  });

  it('owned is ceil5(1.5 x median + 60) at any sample count', () => {
    const r = budgetFromSamples([100, 110, 120, 131].map((x) => s(x)));
    expect(r.ownedS).toBe(225); // median 110 -> 165 + 60
    expect(r.samples).toBe(4);
    expect(budgetFromSamples([s(200)]).ownedS).toBe(360);
    // One slow outlier moves the median, not the budget.
    expect(budgetFromSamples([100, 110, 120, 400].map((x) => s(x))).ownedS).toBe(225);
  });

  it('a deploy twice as slow as usual fails its budget once a typical deploy passes 2 minutes', () => {
    // 2t > 1.5t + 60 when t > 120; under that, the 60 s pad (a laptop's fixed
    // overhead) lets a short deploy slow down a little more before it fails.
    for (const typical of [130, 200, 300]) {
      const r = budgetFromSamples([typical, typical, typical].map((x) => s(x)));
      expect(2 * typical, `typical ${typical}`).toBeGreaterThan(r.ownedS);
    }
  });

  it('end-to-end is owned + 60 when the TLS first look is quick', () => {
    const r = budgetFromSamples([s(100, 3), s(110, 12)]);
    expect(r.tlsAllowanceS).toBe(60);
    expect(r.endToEndS).toBe(r.ownedS + 60);
  });

  it('end-to-end carries 1.5 x the slowest TLS first look when that is more', () => {
    const r = budgetFromSamples([s(100, 3), s(110, 128)]);
    expect(r.tlsAllowanceS).toBe(195); // 192 -> 195
    expect(r.endToEndS).toBe(r.ownedS + 195);
  });
});

describe('reading the results db', () => {
  const dir = createTempDir('calibrate-');
  const dbPath = path.join(dir, 'e2e.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT);
    CREATE TABLE scenarios (id TEXT PRIMARY KEY, run_id TEXT, mode TEXT, provider TEXT, features TEXT);
    CREATE TABLE steps (id TEXT PRIMARY KEY, scenario_id TEXT, name TEXT, status TEXT, cold_warm TEXT);
    CREATE TABLE perf_substep (id INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT, name TEXT, duration_ms INTEGER);
    CREATE TABLE verifications (id TEXT PRIMARY KEY, step_id TEXT, check_name TEXT, details TEXT);
  `);
  let n = 0;
  /** How each provider's server creates are timed (SERVER_RESOURCE_TYPE). */
  const SERVER: Record<string, string> = {
    hetzner: 'Server',
    linode: 'Instance',
    vultr: 'Instance',
    scaleway: 'Server',
  };
  const deploy = (o: {
    run: string;
    started: string;
    provider: string;
    mode: string;
    status?: string;
    coldWarm?: string;
    /** deploy.total, which holds the server creates (30 s by default). */
    totalS: number;
    tlsS?: number;
    /** Each server create's seconds; `[]` records none. */
    serversS?: number[];
    cpuClass?: string;
    /** scenarios.features as recorded: stock (`[]`) by default. */
    features?: string | null;
  }) => {
    n++;
    db.prepare('INSERT OR IGNORE INTO runs VALUES (?, ?)').run(o.run, o.started);
    db.prepare('INSERT INTO scenarios VALUES (?, ?, ?, ?, ?)').run(
      `sc${n}`,
      o.run,
      o.mode,
      o.provider,
      o.features === undefined ? '[]' : o.features,
    );
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(
      `st${n}`,
      `sc${n}`,
      'deploy',
      o.status ?? 'pass',
      o.coldWarm ?? 'cold',
    );
    const perf = db.prepare(
      'INSERT INTO perf_substep (step_id, name, duration_ms) VALUES (?, ?, ?)',
    );
    perf.run(`st${n}`, 'deploy.total', o.totalS * 1000);
    perf.run(`st${n}`, 'deploy.tls.ready', (o.tlsS ?? 0) * 1000);
    perf.run(`st${n}`, 'deploy.iac.upStack.resource.Firewall.firewall', 1500);
    for (const [i, sec] of (o.serversS ?? [30]).entries()) {
      perf.run(`st${n}`, `deploy.iac.upStack.resource.${SERVER[o.provider]}.s${i}`, sec * 1000);
    }
    if (o.cpuClass) {
      db.prepare('INSERT INTO verifications VALUES (?, ?, ?, ?)').run(
        `v${n}`,
        `st${n}`,
        'deploy_budget',
        JSON.stringify({ cpuClass: o.cpuClass }),
      );
    }
  };
  const base = { run: 'r2', started: '2026-11-05T14:00:00Z', provider: 'hetzner', mode: 'compose' };
  deploy({ ...base, totalS: 230, tlsS: 20, cpuClass: 'cx' }); // counts: owned 180 (230 - 20 - 30)
  deploy({ ...base, totalS: 999, status: 'fail', cpuClass: 'cx' }); // failed
  deploy({ ...base, totalS: 999, coldWarm: 'warm', cpuClass: 'cx' }); // warm
  deploy({ ...base, run: 'r1', started: '2026-11-05T01:00:00Z', totalS: 999, cpuClass: 'cx' }); // before --since
  deploy({ ...base, totalS: 999, cpuClass: 'cx', features: '["observability"]' }); // add-ons
  deploy({ ...base, totalS: 999, cpuClass: 'cx', features: null }); // features not recorded
  deploy({ ...base, totalS: 180 }); // classed provider, class not recorded: the `any` row
  deploy({ ...base, provider: 'linode', totalS: 220 });
  deploy({
    ...base,
    run: 'r0',
    started: '2026-11-05T02:00:00Z',
    provider: 'scaleway',
    mode: 'k8s',
    totalS: 99,
  }); // a mode the provider does not run
  db.close();

  it('counts only passing, cold deploys since --since, by provider, mode and class', () => {
    const { table, rows } = buildTable(readSamples(dbPath, '2026-11-05T13:00:00Z'), 'x');
    expect(rows.map((r) => `${r.provider}/${r.mode}/${r.cls}:${r.samples}`).sort()).toEqual([
      'hetzner/compose/any:1',
      'hetzner/compose/cx:1',
      'linode/compose/standard:1',
    ]);
    expect(table.budgets.hetzner.compose.cx.ownedS).toBe(330); // 1.5 x 180 + 60
    expect(table.budgets.hetzner.compose.cx.tlsAllowanceS).toBe(60); // 1.5 x 20 = 30, floor 60
  });

  it('counts only stock deploys (no add-ons) and reports how many it ignored', () => {
    const samples = readSamples(dbPath, '2026-11-05T13:00:00Z');
    // One deploy with add-ons, one with no feature set recorded: neither is
    // proven stock, so neither sets a budget.
    expect(samples.nonStock).toBe(2);
    const built = buildTable(samples, 'x');
    expect(built.table.budgets.hetzner.compose.cx.samples).toBe(1);
    expect(built.nonStock).toBe(2);
    expect(renderReport(built, 'x')).toMatch(
      /Ignored 2 cold deploys that were not stock \(add-ons, or no feature set recorded\)/,
    );
    expect(renderReport({ ...built, nonStock: 0 }, 'x')).toMatch(/Ignored 0 cold deploys/);
  });

  it('puts a sample without a recorded class in the `any` row, never a guessed class', () => {
    const { table } = buildTable(readSamples(dbPath, '2026-11-05T13:00:00Z'), 'x');
    expect(table.budgets.hetzner.compose.any.ownedS).toBe(285); // 1.5 x 150 + 60
    expect(table.budgets.hetzner.compose.ccx).toBeUndefined();
  });

  it('lists only combinations the provider supports, with or without data', () => {
    const built = buildTable(readSamples(dbPath, '2026-11-05T13:00:00Z'), 'x');
    const listed = built.noData.map((d) => `${d.provider}/${d.mode}`);
    for (const unsupported of ['scaleway/k8s', 'scaleway/k8s-ha']) {
      expect(listed).not.toContain(unsupported);
    }
    // Linode runs all four modes, and no provider has a k8s row here, so
    // nothing can seed them: listed until they have data.
    expect(listed).toContain('linode/k8s');
    expect(listed).toContain('linode/k8s-ha');
    expect(listed).not.toContain('hetzner/compose');
    // vultr/compose has no samples but other providers have compose rows: seeded.
    expect(listed).not.toContain('vultr/compose');
    expect(built.seeds.map((x) => `${x.provider}/${x.mode}/${x.cls}`)).toContain(
      'vultr/compose/any',
    );
  });

  it('seeds a provider + mode with no samples from the calibrated rows on the others', () => {
    const { table, seeds } = buildTable(readSamples(dbPath, '2026-11-05T13:00:00Z'), 'x');
    // compose rows: hetzner any 285, hetzner cx 330, linode standard 345 (1.5 x 190 + 60).
    const want = {
      ownedS: 320, // mean 320
      endToEndS: 380, // + the 60 s TLS floor every row has
      tlsAllowanceS: 60,
      samples: 0,
      seededFrom: ['hetzner/compose/any', 'hetzner/compose/cx', 'linode/compose/standard'],
    };
    // A classed provider's seed goes in `any`, the row a run of any class
    // falls back to (a classless one's in `standard`: see the next test).
    expect(table.budgets.vultr.compose).toEqual({ any: want });
    expect(table.budgets.digitalocean.compose).toEqual({ any: want });
    // Seeds never feed seeds: every seed names calibrated rows only.
    for (const x of seeds) {
      for (const name of x.seededFrom) {
        const [p, m, c] = name.split('/');
        expect(table.budgets[p][m][c].samples, name).toBeGreaterThan(0);
      }
    }
    expect(renderReport({ rows: [], seeds, noData: [] }, 'x')).toMatch(
      /- vultr\/compose\/any: owned 320 s, end-to-end 380 s, from hetzner\/compose\/any/,
    );
  });

  it('never computes a seed from another seed', () => {
    const budgets = {
      hetzner: { k8s: { cpx: { ownedS: 300, endToEndS: 315, tlsAllowanceS: 15, samples: 6 } } },
      digitalocean: {
        k8s: {
          any: {
            ownedS: 900,
            endToEndS: 915,
            tlsAllowanceS: 15,
            samples: 0,
            seededFrom: ['vultr/k8s/vc2'],
          },
        },
      },
    };
    expect(seededRow(budgets, 'linode', 'k8s')).toMatchObject({
      ownedS: 300,
      seededFrom: ['hetzner/k8s/cpx'],
    });
  });

  it('never seeds a provider from its own rows, or a mode that has a row', () => {
    const budgets = {
      hetzner: { k8s: { cpx: { ownedS: 300, endToEndS: 315, tlsAllowanceS: 15, samples: 6 } } },
      linode: {
        compose: { standard: { ownedS: 225, endToEndS: 265, tlsAllowanceS: 40, samples: 8 } },
      },
    };
    expect(seededRow(budgets, 'hetzner', 'k8s')).toBeUndefined();
    const { seeds } = addSeeds(budgets);
    const keys = seeds.map((x) => `${x.provider}/${x.mode}`);
    expect(keys).toContain('linode/k8s');
    expect(keys).not.toContain('hetzner/k8s');
    expect(keys).not.toContain('linode/compose');
    expect(budgets.linode.k8s).toEqual({
      standard: {
        ownedS: 300,
        endToEndS: 360, // the TLS floor (60) applies to a seed too
        tlsAllowanceS: 60,
        samples: 0,
        seededFrom: ['hetzner/k8s/cpx'],
      },
    });
  });

  it('ignores a sample of an unsupported mode', () => {
    const { rows } = buildTable(readSamples(dbPath, '2026-11-05T00:00:00Z'), 'x');
    expect(rows.some((r) => r.provider === 'scaleway' && r.mode === 'k8s')).toBe(false);
  });

  it('pools several dbs and counts a step that is in two of them once', async () => {
    const copy = path.join(dir, 'copy.db');
    const src = new Database(dbPath, { readonly: true });
    await src.backup(copy);
    src.close();
    // The copy also holds one deploy the original does not (another leg's run).
    const extra = new Database(copy);
    extra.exec(`
      INSERT INTO runs VALUES ('r9', '2026-11-06T10:00:00Z');
      INSERT INTO scenarios VALUES ('sc-extra', 'r9', 'compose', 'hetzner', '[]');
      INSERT INTO steps VALUES ('st-extra', 'sc-extra', 'deploy', 'pass', 'cold');
      INSERT INTO perf_substep (step_id, name, duration_ms) VALUES ('st-extra', 'deploy.total', 210000);
      INSERT INTO perf_substep (step_id, name, duration_ms)
        VALUES ('st-extra', 'deploy.iac.upStack.resource.Server.server', 30000);
      INSERT INTO verifications VALUES ('v-extra', 'st-extra', 'deploy_budget', '{"cpuClass":"cx"}');
    `);
    extra.close();
    const counts = (dbs: string | string[]) =>
      buildTable(readSamples(dbs, '2026-11-05T13:00:00Z'), 'x').rows.map(
        (r) => `${r.provider}/${r.mode}/${r.cls}:${r.samples}`,
      );
    const one = counts(dbPath);
    expect(one).toContain('hetzner/compose/cx:1');
    expect(counts([dbPath, copy])).toEqual(
      one.map((k) => (k === 'hetzner/compose/cx:1' ? 'hetzner/compose/cx:2' : k)),
    );
  });

  it('carries over from the table it overwrites (--out) the rows its samples do not cover', () => {
    const out = path.join(dir, 'budgets.json');
    const row = (ownedS: number, samples: number) => ({
      ownedS,
      endToEndS: ownedS + 60,
      tlsAllowanceS: 60,
      samples,
    });
    writeFileSync(
      out,
      JSON.stringify({
        rule: 'old',
        since: '2026-11-01T00:00:00.000Z',
        budgets: { hetzner: { compose: { cpx: row(230, 8), cx: row(999, 5) } } },
      }),
    );
    const report = execFileSync(
      process.execPath,
      [
        path.resolve('scripts/calibrate-deploy-budgets.js'),
        '--db',
        dbPath,
        '--since',
        '2026-11-05T13:00:00Z',
        '--out',
        out,
      ],
      { encoding: 'utf8' },
    );
    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect(written.since).toBe('2026-11-05T13:00:00.000Z');
    // A stock sample of cx replaced the old row; cpx had none, so it is carried.
    expect(written.budgets.hetzner.compose.cx).toEqual({
      ownedS: 330,
      endToEndS: 390,
      tlsAllowanceS: 60,
      samples: 1,
    });
    expect(written.budgets.hetzner.compose.cpx).toEqual({
      ...row(230, 8),
      carriedOver: true,
      carriedFromSince: '2026-11-01T00:00:00.000Z',
    });
    expect(report).toMatch(/- hetzner\/compose\/cpx: owned 230 s, end-to-end 290 s, n 8, /);
  });

  it('never writes the db', () => {
    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.exec('DELETE FROM steps')).toThrow(/readonly/);
    ro.close();
  });
});

describe("the deploy-owned time is the check's own measure", () => {
  const dir = createTempDir('calibrate-owned-');
  const dbPath = path.join(dir, 'e2e.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT);
    CREATE TABLE scenarios (id TEXT PRIMARY KEY, run_id TEXT, mode TEXT, provider TEXT, features TEXT);
    CREATE TABLE steps (id TEXT PRIMARY KEY, scenario_id TEXT, name TEXT, status TEXT, cold_warm TEXT);
    CREATE TABLE perf_substep (id INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT, name TEXT, duration_ms INTEGER);
    CREATE TABLE verifications (id TEXT PRIMARY KEY, step_id TEXT, check_name TEXT, details TEXT);
    INSERT INTO runs VALUES ('r1', '2026-11-19T05:00:00Z');
  `);
  /** A stock Hetzner k8s cold deploy that passed, with these `[perf]` rows (ms). */
  const deploy = (id: string, perf: Record<string, number>) => {
    db.prepare("INSERT INTO scenarios VALUES (?, 'r1', 'k8s', 'hetzner', '[]')").run(`sc-${id}`);
    db.prepare("INSERT INTO steps VALUES (?, ?, 'deploy', 'pass', 'cold')").run(id, `sc-${id}`);
    db.prepare(
      'INSERT INTO verifications VALUES (?, ?, \'deploy_budget\', \'{"cpuClass":"cpx"}\')',
    ).run(`v-${id}`, id);
    for (const [name, ms] of Object.entries(perf)) {
      db.prepare('INSERT INTO perf_substep (step_id, name, duration_ms) VALUES (?, ?, ?)').run(
        id,
        name,
        ms,
      );
    }
  };
  // Hetzner k8s on a slow day (run 44515679264): three servers made side by
  // side in 173-192 s, inside a 376 s deploy.
  const slowDay = {
    'deploy.total': 375_874,
    'deploy.tls.ready': 695,
    'deploy.tls.snapshot': 1_183,
    'deploy.k3s.iac.upStack.resource.Network.network': 1_200,
    'deploy.k3s.iac.upStack.resource.Server.db': 172_940,
    'deploy.k3s.iac.upStack.resource.Server.master': 191_303,
    'deploy.k3s.iac.upStack.resource.Server.worker-1': 191_654,
    // Another command's create, never this deploy's.
    'scale.k8s.ci3.upStack.resource.Server.worker-2': 300_000,
  };
  deploy('slow-day', slowDay);
  // No server-create row at all: the provider's wait cannot be taken out.
  deploy('no-servers', { 'deploy.total': 250_000, 'deploy.tls.ready': 2_000 });
  db.close();
  const since = '2026-11-19T00:00:00Z';

  it('takes deploy.total minus the TLS first look and the LONGEST server create, never their sum', () => {
    const { groups } = readSamples(dbPath, since);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toEqual([
      // 182 s, not the 10 s that subtracting all three creates would leave.
      { ownedS: (375_874 - 1_878 - 191_654) / 1000, tlsS: 1.878, serverCreateS: 191.654 },
    ]);
  });

  it('measures exactly what the check judges, with the same function', () => {
    const [sample] = readSamples(dbPath, since).groups[0].rows;
    const log = Object.entries(slowDay)
      .map(([name, ms]) => `[perf] ${name} ${ms}ms`)
      .join('\n');
    const row = { ownedS: 900, endToEndS: 960, samples: 1 };
    const r = checkDeployBudget(
      log,
      'k8s',
      { provider: 'hetzner', cpuClass: 'cpx' },
      { hetzner: { k8s: { cpx: row } } },
    );
    expect(r.details).toMatchObject({
      ownedS: Math.round(sample.ownedS),
      tlsFirstLookS: Math.round(sample.tlsS),
      serverCreateS: Math.round(sample.serverCreateS),
    });
  });

  it('ignores and reports a deploy with no server-create row, never counting the wait as zero', () => {
    const samples = readSamples(dbPath, since);
    expect(samples.noServerCreate).toBe(1);
    expect(samples.groups[0].rows).toHaveLength(1);
    const built = buildTable(samples, since);
    expect(built.table.budgets.hetzner.k8s.cpx.samples).toBe(1);
    const report = renderReport(built, since);
    expect(report).toMatch(
      /Ignored 1 cold deploys with no \[perf\] server-create row for their provider\./,
    );
    // The row shows the provider's wait it left out.
    expect(report).toMatch(/\| hetzner \| k8s \| cpx \| 1 \| 335 \| 395 \| 60 \| 192 \| /);
  });
});

describe('carrying over the rows the stock samples do not cover', () => {
  const OLD_SINCE = '2026-11-05T12:00:00.000Z';
  const NEW_SINCE = '2026-11-15T20:06:33.000Z';
  const row = (ownedS: number, samples: number) => ({
    ownedS,
    endToEndS: ownedS + 60,
    tlsAllowanceS: 60,
    samples,
  });
  const carriedRow = (ownedS: number, samples: number, since = OLD_SINCE) => ({
    ...row(ownedS, samples),
    carriedOver: true,
    carriedFromSince: since,
  });
  const group = (provider: string, mode: string, cls: string, owned: number[]) => ({
    provider,
    mode,
    cls,
    rows: owned.map((x) => s(x)),
  });
  /** The table being overwritten: calibrated before e2e deploys were stock. */
  const previous = {
    rule: 'old',
    since: OLD_SINCE,
    budgets: {
      hetzner: { compose: { any: row(375, 3), cpx: row(230, 8), cx: row(245, 5) } },
      digitalocean: { k8s: { intel: row(390, 6) } },
    },
  };
  const build = (groups: ReturnType<typeof group>[], prev: object | undefined = previous) =>
    buildTable({ groups, nonStock: 0 }, NEW_SINCE, prev);
  const key = (x: { provider: string; mode: string; cls: string }) =>
    `${x.provider}/${x.mode}/${x.cls}`;

  it('carries a class with no stock sample, marked with the since of the table it came from', () => {
    const { table, carried } = build([group('hetzner', 'compose', 'cpx', [100])]);
    expect(table.budgets.hetzner.compose.cx).toEqual(carriedRow(245, 5));
    expect(table.budgets.hetzner.compose.any).toEqual(carriedRow(375, 3));
    expect(table.budgets.digitalocean.k8s.intel).toEqual(carriedRow(390, 6));
    expect(carried.map(key)).toEqual([
      'digitalocean/k8s/intel',
      'hetzner/compose/any',
      'hetzner/compose/cx',
    ]);
  });

  it('a class with stock samples replaces the carried row', () => {
    const { table, rows, carried } = build([group('hetzner', 'compose', 'cpx', [100])]);
    expect(table.budgets.hetzner.compose.cpx).toEqual(budgetFromSamples([s(100)]));
    expect(table.budgets.hetzner.compose.cpx.carriedOver).toBeUndefined();
    expect(rows.map(key)).toEqual(['hetzner/compose/cpx']);
    expect(carried.map(key)).not.toContain('hetzner/compose/cpx');
  });

  it('a carried row is carried again with its first since, until a stock sample replaces it', () => {
    const prev = {
      since: NEW_SINCE,
      budgets: { hetzner: { compose: { cx: carriedRow(245, 5) } } },
    };
    const again = build([group('hetzner', 'compose', 'cpx', [100])], prev);
    expect(again.table.budgets.hetzner.compose.cx).toEqual(carriedRow(245, 5, OLD_SINCE));
    const replaced = build([group('hetzner', 'compose', 'cx', [120])], prev);
    expect(replaced.table.budgets.hetzner.compose.cx).toEqual(budgetFromSamples([s(120)]));
    expect(replaced.carried).toEqual([]);
  });

  it('carried rows never seed, and a provider + mode they cover is judged by them, not a seed', () => {
    // DigitalOcean's only k8s row is carried, so no calibrated k8s row exists
    // anywhere: nothing can seed linode/k8s.
    const none = build([group('hetzner', 'compose', 'cpx', [100])]);
    expect(none.table.budgets.linode?.k8s).toBeUndefined();
    expect(none.noData.map((d) => `${d.provider}/${d.mode}`)).toContain('linode/k8s');
    expect(seededRow(none.table.budgets, 'linode', 'k8s')).toBeUndefined();
    // One calibrated k8s row: the seed is that row alone, never the carried one.
    const one = build([
      group('hetzner', 'compose', 'cpx', [100]),
      group('hetzner', 'k8s', 'cpx', [200]),
    ]);
    expect(one.table.budgets.linode.k8s).toEqual({
      standard: {
        ownedS: 360, // 1.5 x 200 + 60
        endToEndS: 420,
        tlsAllowanceS: 60,
        samples: 0,
        seededFrom: ['hetzner/k8s/cpx'],
      },
    });
    // DigitalOcean k8s keeps its own (carried) number: no seed beside it.
    expect(one.table.budgets.digitalocean.k8s).toEqual({ intel: carriedRow(390, 6) });
    for (const x of one.seeds) {
      for (const name of x.seededFrom) {
        const [p, m, c] = name.split('/');
        expect(one.table.budgets[p][m][c].carriedOver, name).toBeUndefined();
      }
    }
  });

  it('a seed in the table being overwritten is recomputed, never carried', () => {
    const prev = {
      since: OLD_SINCE,
      budgets: {
        vultr: { compose: { any: { ...row(500, 0), seededFrom: ['linode/compose/standard'] } } },
      },
    };
    const { table, carried } = build([group('hetzner', 'compose', 'cpx', [100])], prev);
    expect(carried).toEqual([]);
    expect(table.budgets.vultr.compose).toEqual({
      any: { ...budgetFromSamples([s(100)]), samples: 0, seededFrom: ['hetzner/compose/cpx'] },
    });
  });

  it('drops a row no deploy can be judged by: an unsupported mode, an undeclared class, an unknown provider', () => {
    const prev = {
      since: OLD_SINCE,
      budgets: {
        scaleway: { k8s: { BASIC3: row(300, 4) } },
        hetzner: { compose: { zz9: row(300, 4) } },
        nope: { compose: { any: row(300, 4) } },
      },
    };
    const { table, carried } = build([group('hetzner', 'compose', 'cpx', [100])], prev);
    expect(carried).toEqual([]);
    expect(table.budgets.scaleway?.k8s).toBeUndefined();
    expect(table.budgets.hetzner.compose.zz9).toBeUndefined();
    expect(table.budgets.nope).toBeUndefined();
  });

  it('carries nothing when there is no table to overwrite', () => {
    const { table, carried } = buildTable(
      { groups: [group('hetzner', 'compose', 'cpx', [100])] },
      NEW_SINCE,
    );
    expect(carried).toEqual([]);
    expect(Object.keys(table.budgets.hetzner.compose)).toEqual(['cpx']);
  });

  it('writes carried rows in the same order as calibrated ones', () => {
    const { table } = build([group('hetzner', 'compose', 'cpx', [100])]);
    expect(Object.keys(table.budgets)).toEqual([
      'digitalocean',
      'hetzner',
      'linode',
      'scaleway',
      'vultr',
    ]);
    expect(Object.keys(table.budgets.hetzner.compose)).toEqual(['any', 'cpx', 'cx']);
  });

  it('the report lists the carried rows in their own section, never in the calibrated table', () => {
    const built = build([group('hetzner', 'compose', 'cpx', [100])]);
    const report = renderReport(built, NEW_SINCE);
    const [calibrated] = report.split('\n## ');
    expect(calibrated).toMatch(/\| hetzner \| compose \| cpx \| 1 \|/);
    expect(calibrated).not.toMatch(/\| cx \||\| any \||\| intel \|/);
    const section = report.split('\n## Carried over')[1]?.split('\n## ')[0];
    expect(section).toBeDefined();
    expect(section).toMatch(
      /- hetzner\/compose\/cx: owned 245 s, end-to-end 305 s, n 5, calibrated since 2026-11-05T12:00:00\.000Z/,
    );
    expect(section).toMatch(/- hetzner\/compose\/any: owned 375 s/);
    expect(section).toMatch(/- digitalocean\/k8s\/intel: owned 390 s/);
  });
});
