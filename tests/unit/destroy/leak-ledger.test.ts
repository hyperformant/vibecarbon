/**
 * Destroy leak ledger — the single accounting every teardown class reports
 * into, and the exit-code policy derived from it.
 *
 * The gap this closes (found 2026-07-22 during the prod re-home): destroy was
 * best-effort per resource and exited 0 even when deletions failed, so a
 * "completed" destroy left live servers and firewalls behind and no script
 * could tell that apart from a clean teardown.
 */
import { describe, expect, it } from 'vitest';
import {
  createLeakLedger,
  DESTROY_EXIT_CLEAN,
  DESTROY_EXIT_FAILED,
  DESTROY_EXIT_LEAKED,
  describeResource,
  formatLeakReport,
  isLeakReportLine,
  renderLeakReportLines,
} from '../../../src/lib/destroy/leak-ledger.js';

describe('createLeakLedger — accounting', () => {
  it('starts clean and exits 0', () => {
    const ledger = createLeakLedger();
    expect(ledger.entries).toEqual([]);
    expect(ledger.isClean()).toBe(true);
    expect(ledger.exitCode()).toBe(DESTROY_EXIT_CLEAN);
    expect(DESTROY_EXIT_CLEAN).toBe(0);
  });

  it('records a leak with its class, resource and reason', () => {
    const ledger = createLeakLedger();
    ledger.leak({
      resourceClass: 'server',
      resource: 'acme-prod (id 4821)',
      reason: 'delete failed: server is locked',
      hint: 'Delete it via the console.',
    });
    expect(ledger.entries).toEqual([
      {
        severity: 'leak',
        resourceClass: 'server',
        resource: 'acme-prod (id 4821)',
        reason: 'delete failed: server is locked',
        hint: 'Delete it via the console.',
      },
    ]);
    expect(ledger.counts()).toMatchObject({ leak: 1, unverified: 0, foreign: 0, risk: 0 });
  });

  it('de-duplicates identical records so one resource is reported once', () => {
    const ledger = createLeakLedger();
    for (let i = 0; i < 3; i++) {
      ledger.leak({ resourceClass: 'firewall', resource: 'acme-prod-fw', reason: 'rate limited' });
    }
    expect(ledger.entries).toHaveLength(1);
  });

  it('keeps distinct reasons for the same resource — they are different evidence', () => {
    const ledger = createLeakLedger();
    ledger.leak({ resourceClass: 'firewall', resource: 'acme-prod-fw', reason: 'delete refused' });
    ledger.leak({ resourceClass: 'firewall', resource: 'acme-prod-fw', reason: 'still attached' });
    expect(ledger.entries).toHaveLength(2);
  });

  it('preserves insertion order across severities', () => {
    const ledger = createLeakLedger();
    ledger.risk({ resourceClass: 'bucket', resource: 'b1', reason: 'no keys' });
    ledger.leak({ resourceClass: 'server', resource: 's1', reason: 'boom' });
    ledger.unverified({ resourceClass: 'volume', resource: 'listing', reason: 'HTTP 503' });
    expect(ledger.entries.map((e) => e.severity)).toEqual(['risk', 'leak', 'unverified']);
  });

  it('tolerates a missing hint and trims multi-line API error text to one line', () => {
    const ledger = createLeakLedger();
    ledger.leak({
      resourceClass: 'network',
      resource: 'acme-prod-network',
      reason: 'delete refused: still has members\n  at Object.<anonymous>\n  at async',
    });
    expect(ledger.entries[0].hint).toBeUndefined();
    expect(ledger.entries[0].reason).toBe('delete refused: still has members');
  });
});

describe('exit-code policy', () => {
  it('exits 2 when anything leaked — never 0, never the generic 1', () => {
    const ledger = createLeakLedger();
    ledger.leak({ resourceClass: 'server', resource: 's1', reason: 'delete failed' });
    expect(ledger.exitCode()).toBe(DESTROY_EXIT_LEAKED);
    expect(DESTROY_EXIT_LEAKED).toBe(2);
    expect(DESTROY_EXIT_LEAKED).not.toBe(DESTROY_EXIT_FAILED);
  });

  it('exits 2 when a listing was incomplete — an unreadable listing cannot produce a clean verdict', () => {
    const ledger = createLeakLedger();
    ledger.unverified({
      resourceClass: 'volume',
      resource: 'volume listing',
      reason: 'listing incomplete (HTTP 503)',
    });
    expect(ledger.isClean()).toBe(false);
    expect(ledger.exitCode()).toBe(DESTROY_EXIT_LEAKED);
  });

  it('stays 0 for foreign resources — proven NOT ours, so not our leak', () => {
    const ledger = createLeakLedger();
    ledger.foreign({
      resourceClass: 'volume',
      resource: 'pvc-1111 (nbg1)',
      reason: 'our PersistentVolume list is complete and does not contain it',
    });
    expect(ledger.exitCode()).toBe(DESTROY_EXIT_CLEAN);
    // ...but it is still reported.
    expect(ledger.isClean()).toBe(false);
    expect(ledger.entries).toHaveLength(1);
  });

  it('stays 0 for a leak-RISK alone — the risk is a predictor, the bucket verdict is the proof', () => {
    const ledger = createLeakLedger();
    ledger.risk({
      resourceClass: 'bucket',
      resource: 'acme-prod (fsn1)',
      reason: 'HETZNER_ACCESS_KEY is not set',
    });
    expect(ledger.exitCode()).toBe(DESTROY_EXIT_CLEAN);
  });

  it('escalates to 2 as soon as one real leak joins the risks', () => {
    const ledger = createLeakLedger();
    ledger.risk({ resourceClass: 'bucket', resource: 'b', reason: 'no keys' });
    ledger.foreign({ resourceClass: 'volume', resource: 'v', reason: 'not ours' });
    expect(ledger.exitCode()).toBe(DESTROY_EXIT_CLEAN);
    ledger.leak({ resourceClass: 'ssh-key', resource: 'k', reason: 'delete failed' });
    expect(ledger.exitCode()).toBe(DESTROY_EXIT_LEAKED);
  });
});

describe('describeResource', () => {
  it('prefers the name and appends id + region when present', () => {
    expect(describeResource({ name: 'acme-prod', id: 4821, region: 'nbg1' })).toBe(
      'acme-prod (id 4821, nbg1)',
    );
  });

  it('falls back to the id when there is no name', () => {
    expect(describeResource({ id: 4821 })).toBe('id 4821');
  });

  it('never renders an empty description', () => {
    expect(describeResource({})).toBe('(unidentified)');
  });
});

describe('formatLeakReport', () => {
  it('reports one line per surviving resource, then a summary count', () => {
    const ledger = createLeakLedger();
    ledger.leak({
      resourceClass: 'server',
      resource: 'acme-prod (id 4821)',
      reason: 'delete failed: server is locked',
    });
    ledger.leak({
      resourceClass: 'firewall',
      resource: 'acme-prod-firewall',
      reason: 'delete did not complete: rate limited',
    });
    ledger.unverified({
      resourceClass: 'volume',
      resource: 'volume listing (all regions)',
      reason: 'listing incomplete — surviving volumes cannot be ruled out',
    });

    const report = formatLeakReport(ledger, { environment: 'prod' });
    expect(report.clean).toBe(false);
    expect(report.header).toContain('prod');
    expect(report.lines).toHaveLength(3);
    expect(report.lines[0].text).toContain('server');
    expect(report.lines[0].text).toContain('acme-prod (id 4821)');
    expect(report.lines[0].text).toContain('delete failed: server is locked');
    expect(report.summary).toMatch(/2 leaked/);
    expect(report.summary).toMatch(/1 unverifiable/);
    expect(report.summary).toMatch(/exit 2/);
  });

  it('prints a one-line all-clear for a clean destroy', () => {
    const report = formatLeakReport(createLeakLedger(), { environment: 'staging' });
    expect(report.clean).toBe(true);
    expect(report.lines).toEqual([]);
    expect(report.summary).toMatch(/no leaked resources/i);
    expect(report.summary).toMatch(/read in full/i);
  });

  it('renders plain, greppable lines whose severity token leads', () => {
    const ledger = createLeakLedger();
    ledger.leak({ resourceClass: 'server', resource: 's1', reason: 'boom', hint: 'do the thing' });
    ledger.foreign({ resourceClass: 'volume', resource: 'pvc-1', reason: 'not ours' });
    const lines = renderLeakReportLines(formatLeakReport(ledger, { environment: 'prod' }));
    expect(lines.some((l) => /^\s*LEAK\s+server\s+s1: boom$/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('FOREIGN') && l.includes('pvc-1'))).toBe(true);
    expect(lines.some((l) => l.includes('do the thing'))).toBe(true);
  });

  it('counts foreign and at-risk separately from leaks in the summary', () => {
    const ledger = createLeakLedger();
    ledger.foreign({ resourceClass: 'volume', resource: 'v', reason: 'not ours' });
    ledger.risk({ resourceClass: 'bucket', resource: 'b', reason: 'no keys' });
    const report = formatLeakReport(ledger, { environment: 'prod' });
    expect(report.clean).toBe(false);
    expect(report.summary).toMatch(/1 foreign/);
    expect(report.summary).toMatch(/1 at risk/);
    expect(report.summary).toMatch(/exit 0/);
  });
});

describe('isLeakReportLine — the renderer/scraper contract', () => {
  // Scripted callers only receive an exit code over the process boundary. The
  // e2e runner turns "exit 2" into a failure that NAMES the survivors by
  // scraping these lines back out of captured stdout, so every rendered
  // verdict line must match, and nothing else may.
  it('matches every rendered verdict line, in every severity', () => {
    const ledger = createLeakLedger();
    ledger.leak({ resourceClass: 'server', resource: 's1', reason: 'boom' });
    ledger.unverified({ resourceClass: 'volume', resource: 'listing', reason: 'incomplete' });
    ledger.foreign({ resourceClass: 'volume', resource: 'pvc-1', reason: 'not ours' });
    ledger.risk({ resourceClass: 'bucket', resource: 'b', reason: 'no keys' });

    const report = formatLeakReport(ledger, { environment: 'prod' });
    for (const line of report.lines) {
      expect(isLeakReportLine(`  ${line.text}`)).toBe(true);
    }
    const matched = renderLeakReportLines(report).filter(isLeakReportLine);
    expect(matched).toHaveLength(4);
  });

  it('does not match the header, the summary, or hint continuation lines', () => {
    const ledger = createLeakLedger();
    ledger.leak({ resourceClass: 'server', resource: 's1', reason: 'boom', hint: 'go delete it' });
    const report = formatLeakReport(ledger, { environment: 'prod' });
    expect(isLeakReportLine(report.header)).toBe(false);
    expect(isLeakReportLine(report.summary)).toBe(false);
    expect(isLeakReportLine('    ↳ go delete it')).toBe(false);
  });

  it('does not match ordinary destroy output that merely mentions a leak', () => {
    expect(isLeakReportLine('  [volume] DEFERRED pvc-1 — kept because ...')).toBe(false);
    expect(isLeakReportLine('a LEAK was reported earlier')).toBe(false);
  });
});
