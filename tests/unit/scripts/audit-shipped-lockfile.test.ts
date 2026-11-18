import { describe, expect, it } from 'vitest';
import { blockingAdvisories, judge, NO_FIX_YET } from '../../../scripts/audit-shipped-lockfile.mjs';
import { readRepoFile } from '../../_shared/source-files.js';

// The shape `npm audit --json` gives: the advisory sits on the package it is
// against, and every dependent repeats the package name as a string.
const via = (over: Record<string, unknown> = {}) => ({
  source: 1,
  name: 'picomatch',
  title: 'ReDoS',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
  range: '<=4.0.7',
  ...over,
});
const report = (...vias: unknown[]) => ({
  vulnerabilities: {
    picomatch: { via: vias },
    vite: { via: ['picomatch'] },
    vitest: { via: ['picomatch', 'vite'] },
  },
});
const entry = {
  advisory: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  newestRelease: '4.0.7',
  added: '2026-11-17',
};

describe('blockingAdvisories', () => {
  it('reports an advisory once, however many packages depend on it', () => {
    expect(blockingAdvisories(report(via()))).toEqual([
      expect.objectContaining({ advisory: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch' }),
    ]);
  });

  it('leaves out moderate and low', () => {
    expect(
      blockingAdvisories(report(via({ severity: 'moderate' }), via({ severity: 'low' }))),
    ).toEqual([]);
  });

  it('keeps critical', () => {
    expect(blockingAdvisories(report(via({ severity: 'critical' })))).toHaveLength(1);
  });
});

describe('judge', () => {
  const advisories = blockingAdvisories(report(via()));

  it('fails on a high advisory nobody listed', () => {
    const { failures, waived } = judge({
      advisories,
      noFixYet: [],
      newestReleaseOf: () => '4.0.7',
    });
    expect(failures).toHaveLength(1);
    expect(waived).toEqual([]);
  });

  it('reports a listed advisory without failing while no newer release exists', () => {
    const { failures, waived } = judge({
      advisories,
      noFixYet: [entry],
      newestReleaseOf: () => '4.0.7',
    });
    expect(failures).toEqual([]);
    expect(waived).toHaveLength(1);
  });

  it('fails again the day a newer release is published', () => {
    const { failures } = judge({
      advisories,
      noFixYet: [entry],
      newestReleaseOf: () => '4.0.8',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('4.0.8 is out');
  });

  it('does not let an entry cover a different advisory against the same package', () => {
    const other = blockingAdvisories(
      report(via({ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' })),
    );
    const { failures } = judge({
      advisories: other,
      noFixYet: [entry],
      newestReleaseOf: () => '4.0.7',
    });
    // The new advisory fails, and the entry that matched nothing fails too.
    expect(failures).toHaveLength(2);
  });

  it('fails on an entry the audit no longer reports', () => {
    const { failures } = judge({
      advisories: [],
      noFixYet: [entry],
      newestReleaseOf: () => '4.0.7',
    });
    expect(failures).toEqual([expect.stringContaining('delete the entry')]);
  });
});

describe('the gate is wired', () => {
  it('the template job runs this script, not a bare npm audit', () => {
    const workflow = readRepoFile('.github', 'workflows', 'test.yml');
    expect(workflow).toContain('run: node ../scripts/audit-shipped-lockfile.mjs');
    expect(workflow).not.toMatch(/^\s*run: npm audit\b/m);
  });
});

describe('the list of advisories with no fix', () => {
  it('every entry is complete and dated', () => {
    for (const e of NO_FIX_YET) {
      expect(e.advisory).toMatch(/^GHSA(-[a-z0-9]{4}){3}$/);
      expect(e.package).toBeTruthy();
      expect(e.newestRelease).toMatch(/^\d+\.\d+\.\d+/);
      expect(e.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
