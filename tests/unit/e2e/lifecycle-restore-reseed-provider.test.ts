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
 * (warm-deploy, warm-redeploy-change, restore, reconverge-deploy after
 * failover) calls
 * `runDeploy()`, which re-seeds `.vibecarbon.json` via seedDeployEnvConfig
 * (see seed-deploy-env-config.test.ts for that helper's own coverage). Only
 * the INITIAL 'deploy' step's call passed `provider: config.provider` — the
 * other three omitted it, so a DigitalOcean scenario's re-seed silently
 * dropped `provider` and the redeployed CLI defaulted to Hetzner
 * (providerFor's sanctioned fallback for a missing key), tripping the
 * region guard on a DO-only region. Every `runDeploy(config.envPrefix, {`
 * call site must pass `provider: config.provider` — this fails loudly if a
 * future call site (or a new lifecycle step) omits it again.
 */
describe('_run-lifecycle.ts: every runDeploy() re-seed carries the scenario provider', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../tests/e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf8',
  );

  it('has exactly the known 5 runDeploy call sites (deploy, warm-deploy, warm-redeploy-change, restore, reconverge-deploy)', () => {
    const matches = [...src.matchAll(/runDeploy\(config\.envPrefix, \{/g)];
    // A deliberately rigid count: adding a 6th lifecycle re-deploy step
    // should force a look at this test, not silently skip coverage.
    // (Raised 4 -> 5 when `warm-redeploy-change` landed — the rigid count did
    // its job and made that step's re-seed prove it carries `provider`, which
    // matters because the step also runs on the DigitalOcean d3 scenario.)
    expect(matches.length).toBe(5);
  });

  it('every runDeploy call site passes provider: config.provider before its env block', () => {
    const starts = [...src.matchAll(/runDeploy\(config\.envPrefix, \{/g)].map((m) => m.index);
    expect(starts.length).toBeGreaterThan(0);

    for (const start of starts) {
      const envTokenIdx = src.indexOf('env: { HCLOUD_TOKEN: hetznerToken }', start);
      const providerIdx = src.indexOf('provider: config.provider,', start);
      expect(envTokenIdx).toBeGreaterThan(start);
      expect(providerIdx).toBeGreaterThan(start);
      expect(providerIdx).toBeLessThan(envTokenIdx);
    }
  });
});
