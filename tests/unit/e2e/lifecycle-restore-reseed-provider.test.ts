import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard: _run-lifecycle.ts has no unit harness (it's a giant
 * scenario-definition file exercised only by real-infra e2e runs), so this
 * pins a wiring invariant statically rather than behaviorally — same
 * convention as preplan-spinner-coverage.test.ts.
 *
 * RCA (d1 restore-after-destroy failure): every re-deploy in the lifecycle
 * (warm-deploy, warm-redeploy-change, restore-deploy, restore,
 * reconverge-deploy after failover) re-seeds `.vibecarbon.json` via
 * seedDeployEnvConfig (see seed-deploy-env-config.test.ts for that helper's
 * own coverage). Only the INITIAL 'deploy' step's call passed
 * `provider: config.provider`; the others omitted it, so a DigitalOcean
 * scenario's re-seed silently dropped `provider` and the redeployed CLI
 * defaulted to Hetzner (providerFor's sanctioned fallback for a missing
 * key), tripping the region guard on a DO-only region.
 *
 * The six call sites used to repeat the whole settings object, and this
 * test checked each copy. They now go through one helper, `deployScenario`,
 * so the invariant is pinned in three parts: the helper passes every
 * setting, nothing deploys around the helper, and the six steps still call
 * it.
 */
describe('_run-lifecycle.ts: every deploy re-seed carries the scenario settings', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../tests/e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf8',
  );

  /** The `deployScenario` helper's source, up to the end of its runDeploy call. */
  const helper = (() => {
    const start = src.indexOf('const deployScenario = (');
    const end = src.indexOf('\n    });\n', start);
    return start === -1 || end === -1 ? '' : src.slice(start, end);
  })();

  it('the helper exists and makes the one runDeploy(config.envPrefix, …) call in the file', () => {
    expect(helper, 'deployScenario helper not found').not.toBe('');
    expect(helper).toContain('runDeploy(config.envPrefix, {');
    expect([...src.matchAll(/runDeploy\(/g)]).toHaveLength(1);
  });

  it('the helper passes provider: config.provider before its env block, and every other setting', () => {
    const providerIdx = helper.indexOf('provider: config.provider,');
    const envIdx = helper.indexOf('env: hcloudEnv');
    expect(providerIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(providerIdx);
    for (const setting of [
      'cwd: config.projectDir,',
      'timeout,',
      'mode: config.mode,',
      'domain: config.domain,',
      'dnsProvider: config.dnsProvider,',
      'serverType: config.serverType,',
      'region: config.region,',
      'secondaryRegion: config.secondaryRegion,',
      '...expandedDeployBounds,',
    ]) {
      expect(helper, setting).toContain(setting);
    }
  });

  it('exactly the known 6 steps deploy, each with its own time budget (deploy, warm-deploy, warm-redeploy-change, restore-deploy, restore, reconverge-deploy)', () => {
    // A deliberately rigid count: adding a 7th lifecycle re-deploy step
    // should force a look at this test, not silently skip coverage.
    const budgets = [
      ...src.matchAll(/deployScenario\(\s*(?:\/\/[^\n]*\n\s*)*(TIMEOUTS[^,)\n]+)/g),
    ].map((m) => m[1]);
    expect(budgets).toEqual([
      'TIMEOUTS.deploy',
      "TIMEOUTS['warm-deploy']",
      "TIMEOUTS['warm-redeploy-change']",
      "TIMEOUTS['restore-deploy']",
      'TIMEOUTS.deploy',
      "TIMEOUTS['reconverge-deploy']",
    ]);
  });

  it('only restore-deploy asks for a restore', () => {
    expect([...src.matchAll(/restore: 'latest'/g)]).toHaveLength(1);
    expect(src).toMatch(
      /deployScenario\(\s*TIMEOUTS\['restore-deploy'\],\s*\{\s*restore: 'latest',?\s*\},?\s*\)/,
    );
  });
});
