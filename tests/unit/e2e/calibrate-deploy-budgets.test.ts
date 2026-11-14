import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
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

const s = (ownedS: number, tlsS = 5) => ({ ownedS, tlsS });

describe('the budget rule', () => {
  it('ceil5 rounds up to a multiple of 5', () => {
    expect([ceil5(0), ceil5(1), ceil5(5), ceil5(5.01), ceil5(212)]).toEqual([0, 5, 5, 10, 215]);
  });

  it('p90 is nearest-rank', () => {
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it('n >= 4: ceil5(p90 + 15)', () => {
    const r = budgetFromSamples([100, 110, 120, 131].map((x) => s(x)));
    expect(r.ownedS).toBe(150); // p90 = 131 -> 146 -> 150
    expect(r.samples).toBe(4);
  });

  it('n < 4: ceil5(max + 30)', () => {
    expect(budgetFromSamples([s(100), s(131)]).ownedS).toBe(165); // 161 -> 165
    expect(budgetFromSamples([s(200)]).ownedS).toBe(230);
  });

  it('end-to-end is owned + 15 when the TLS first look is quick', () => {
    const r = budgetFromSamples([s(100, 3), s(110, 12)]);
    expect(r.tlsAllowanceS).toBe(15);
    expect(r.endToEndS).toBe(r.ownedS + 15);
  });

  it('end-to-end carries the TLS first look when it needs more than 15 s', () => {
    const r = budgetFromSamples([s(100, 3), s(110, 128)]);
    expect(r.tlsAllowanceS).toBe(130);
    expect(r.endToEndS).toBe(r.ownedS + 130);
  });
});

describe('reading the results db', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'calibrate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'e2e.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT);
    CREATE TABLE scenarios (id TEXT PRIMARY KEY, run_id TEXT, mode TEXT, provider TEXT);
    CREATE TABLE steps (id TEXT PRIMARY KEY, scenario_id TEXT, name TEXT, status TEXT, cold_warm TEXT);
    CREATE TABLE perf_substep (id INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT, name TEXT, duration_ms INTEGER);
    CREATE TABLE verifications (id TEXT PRIMARY KEY, step_id TEXT, check_name TEXT, details TEXT);
  `);
  let n = 0;
  const deploy = (o: {
    run: string;
    started: string;
    provider: string;
    mode: string;
    status?: string;
    coldWarm?: string;
    totalS: number;
    tlsS?: number;
    cpuClass?: string;
  }) => {
    n++;
    db.prepare('INSERT OR IGNORE INTO runs VALUES (?, ?)').run(o.run, o.started);
    db.prepare('INSERT INTO scenarios VALUES (?, ?, ?, ?)').run(
      `sc${n}`,
      o.run,
      o.mode,
      o.provider,
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
  deploy({ ...base, totalS: 200, tlsS: 20, cpuClass: 'cx' }); // counts: owned 180
  deploy({ ...base, totalS: 999, status: 'fail', cpuClass: 'cx' }); // failed
  deploy({ ...base, totalS: 999, coldWarm: 'warm', cpuClass: 'cx' }); // warm
  deploy({ ...base, run: 'r1', started: '2026-11-05T01:00:00Z', totalS: 999, cpuClass: 'cx' }); // before --since
  deploy({ ...base, totalS: 150 }); // classed provider, class not recorded: the `any` row
  deploy({ ...base, provider: 'linode', totalS: 190 });
  deploy({
    ...base,
    run: 'r0',
    started: '2026-11-05T02:00:00Z',
    provider: 'vultr',
    mode: 'k8s',
    totalS: 99,
  }); // classless provider: standard
  db.close();

  it('counts only passing, cold deploys since --since, by provider, mode and class', () => {
    const { table, rows } = buildTable(readSamples(dbPath, '2026-11-05T13:00:00Z'), 'x');
    expect(rows.map((r) => `${r.provider}/${r.mode}/${r.cls}:${r.samples}`).sort()).toEqual([
      'hetzner/compose/any:1',
      'hetzner/compose/cx:1',
      'linode/compose/standard:1',
    ]);
    expect(table.budgets.hetzner.compose.cx.ownedS).toBe(210); // 180 + 30
    expect(table.budgets.hetzner.compose.cx.tlsAllowanceS).toBe(20);
  });

  it('puts a sample without a recorded class in the `any` row, never a guessed class', () => {
    const { table } = buildTable(readSamples(dbPath, '2026-11-05T13:00:00Z'), 'x');
    expect(table.budgets.hetzner.compose.any.ownedS).toBe(180); // 150 + 30
    expect(table.budgets.hetzner.compose.ccx).toBeUndefined();
  });

  it('lists only combinations the provider supports, with or without data', () => {
    const built = buildTable(readSamples(dbPath, '2026-11-05T13:00:00Z'), 'x');
    const listed = built.noData.map((d) => `${d.provider}/${d.mode}`);
    for (const unsupported of ['vultr/k8s', 'scaleway/k8s-ha']) {
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
    // compose rows: hetzner any 180, hetzner cx 210, linode standard 220 (190 + 30).
    const want = {
      ownedS: 205, // mean 203.3 -> 205
      endToEndS: 225, // + cx's 20 s TLS allowance (mean 16.7 -> 20)
      tlsAllowanceS: 20,
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
      /- vultr\/compose\/any: owned 205 s, end-to-end 225 s, from hetzner\/compose\/any/,
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
        endToEndS: 315,
        tlsAllowanceS: 15,
        samples: 0,
        seededFrom: ['hetzner/k8s/cpx'],
      },
    });
  });

  it('ignores a sample of an unsupported mode', () => {
    const { rows } = buildTable(readSamples(dbPath, '2026-11-05T00:00:00Z'), 'x');
    expect(rows.some((r) => r.provider === 'vultr' && r.mode === 'k8s')).toBe(false);
  });

  it('never writes the db', () => {
    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.exec('DELETE FROM steps')).toThrow(/readonly/);
    ro.close();
  });
});
