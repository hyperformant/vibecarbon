/**
 * Census: every `pulumi refresh` in src runs after pruneVultrGoneResources.
 *
 * A refresh of a Vultr stack fails on a resource Vultr has already deleted
 * when the provider's Read cannot tell (lib/iac/vultr-gone-resources.js), so
 * every refresh is preceded by the prune. Its behaviour at each site is
 * tests/unit/iac/vultr-gone-prune-wiring.test.ts; this holds the set of
 * sites, so a new refresh fails here until it prunes first or is named below.
 *
 * Every `.refresh(` call in the code of src (not in a comment or a string) is
 * listed with the function it is in. A function that calls `.refresh(` itself
 * prunes before it; refreshBestEffort's callers prune before they call it.
 * The files whose `.refresh(` is not Pulumi's are named in NOT_PULUMI, with
 * the check that keeps them so.
 */
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';
import { CODE, findCalls, functionRanges, lex } from '../helpers/js-call-scan.js';

/** Every `.refresh(` member call in code: its file and enclosing function. */
function refreshCalls(file: string, text: string) {
  const { mask, errors } = lex(text);
  expect(errors, file).toEqual([]);
  const ranges = functionRanges(text, mask);
  const out: Array<{ file: string; fn: string; at: number }> = [];
  for (const m of text.matchAll(/\.refresh\s*\(/g)) {
    const at = m.index ?? 0;
    if (mask[at] !== CODE) continue;
    let best: { name: string; start: number; end: number } | undefined;
    for (const r of ranges) {
      if (r.start <= at && at <= r.end && (!best || r.start > best.start)) best = r;
    }
    out.push({ file, fn: best?.name ?? '<module>', at });
  }
  return out;
}

const INDEX = 'src/lib/iac/index.js';
const AUTOSCALER = 'src/autoscaler/service.js';
/** Files whose `.refresh(` calls run no Pulumi. */
const NOT_PULUMI = new Set([
  // The autoscaler's GroupManager.refresh: it lists the group's servers
  // through the provider's REST API. The autoscaler never imports Pulumi
  // (checked below).
  AUTOSCALER,
]);
const index = readRepoFile(INDEX);

/** Whether `fn` in index.js calls pruneVultrGoneResources before offset `at`. */
function prunesBefore(fn: string, at: number) {
  return findCalls(index, ['pruneVultrGoneResources']).some((c) => c.fn === fn && c.at < at);
}

describe('every refresh runs after the Vultr prune', () => {
  const sites = sourceFiles(`${REPO_ROOT}/src`, { exts: ['.js'], relativeTo: REPO_ROOT }).flatMap(
    (file) => refreshCalls(file, readRepoFile(file)),
  );

  it('the Pulumi refreshes in src are the two this census knows', () => {
    const named = sites
      .filter(({ file }) => !NOT_PULUMI.has(file))
      .map(({ file, fn }) => `${file} ${fn}`);
    expect(named.sort()).toEqual([`${INDEX} refreshBestEffort`, `${INDEX} resolvePendingCreates`]);
  });

  it('the one that is not Pulumi is still there, and still runs no Pulumi', () => {
    expect(sites.map(({ file }) => file)).toContain(AUTOSCALER);
    const autoscaler = sourceFiles(`${REPO_ROOT}/src/autoscaler`, {
      exts: ['.js'],
      relativeTo: REPO_ROOT,
    });
    expect(autoscaler.length).toBeGreaterThan(0);
    for (const file of autoscaler) {
      expect(readRepoFile(file), file).not.toMatch(/@pulumi\/|lib\/iac\//);
    }
  });

  it('resolvePendingCreates prunes before its refresh', () => {
    const site = sites.find((s) => s.fn === 'resolvePendingCreates');
    expect(site && prunesBefore('resolvePendingCreates', site.at)).toBe(true);
  });

  it('every caller of refreshBestEffort prunes before it calls it', () => {
    const callers = findCalls(index, ['refreshBestEffort']);
    expect(callers.map((c) => c.fn).sort()).toEqual(['destroyStack', 'prepareStackForUp']);
    for (const call of callers) {
      expect(prunesBefore(call.fn, call.at), `${call.fn} line ${call.line}`).toBe(true);
    }
  });

  it('bites: a refresh with no prune before it is found', () => {
    const text = 'async function rogue(stack) {\n  await stack.refresh({ color: "never" });\n}\n';
    expect(refreshCalls('x.js', text).map(({ file, fn }) => `${file} ${fn}`)).toEqual([
      'x.js rogue',
    ]);
    // A comment or a string never counts.
    expect(refreshCalls('y.js', '// stack.refresh()\nconst s = "a.refresh(";\n')).toEqual([]);
  });
});
