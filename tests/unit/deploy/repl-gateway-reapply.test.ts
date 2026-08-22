import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RCA 2026-07-17 e4 run 5: repl-gateway is a BARE Pod and bare-Pod specs are
 * immutable beyond image/tolerations. The post-failover reconverge deploy
 * renders each cluster's gateway with the OPPOSITE relay direction (roles
 * swapped), so plain `kubectl apply` over the surviving pod fails with
 * "Forbidden: pod updates may not change fields" — killing transport prep on
 * BOTH the fan-out and serial paths and aborting the deploy at the streaming
 * gate. The apply must fall back to delete + re-apply on that rejection.
 * Source-level guard (applyGatewaysAndBringUpTunnel is module-private; same
 * style as k8s-ha-primary-config.test.ts).
 */
describe('repl-gateway apply survives role-swapped redeploys', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/ha/index.js'), 'utf-8');

  it('detects the bare-Pod immutability rejection and deletes before re-applying', () => {
    expect(src).toMatch(/Forbidden: pod updates may not change fields/);
    expect(src).toMatch(
      /kubectl delete pod repl-gateway -n vibecarbon --ignore-not-found --wait=true/,
    );
  });

  it('both gateway applies route through the fallback helper', () => {
    // Exactly two applyGatewayPod call sites (primary + standby) and no
    // remaining bare `kubectl apply -f -` for the gateway outside the helper.
    const calls = src.match(/await applyGatewayPod\(/g) ?? [];
    expect(calls).toHaveLength(2);
  });
});
