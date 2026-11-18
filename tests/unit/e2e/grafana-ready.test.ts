/**
 * reconverge-deploy waits for Grafana to be Ready before it probes Grafana
 * from outside, for as long as Grafana's own manifest allows its first boot.
 *
 * GitHub run 43694492910 (digitalocean/k8s-ha): the reconverge applied
 * observability to the promoted cluster for the first time (a pilot-light
 * standby never has it), so Grafana booted from an empty volume and ran its
 * migrations. The outside checks then waited 12 x 5 s for a route that Traefik
 * drops while the Service has no ready endpoints ("no servers found for
 * vibecarbon-observability/grafana"), so `/admin/grafana` fell through to the
 * app's page and the step failed. Diagnostics 3 minutes later showed Grafana
 * 1/1 Running. The manifest's startup probe allows 2 s x 150 = 300 s, so the
 * check gave Grafana a fifth of the time the product does.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';
import {
  GRAFANA_NAMESPACE,
  grafanaStartupAllowanceSeconds,
  waitForGrafanaReady,
} from '../../e2e/checks/grafana-ready.js';
import { runPostReconvergeObservability } from '../../e2e/scenarios/observability-step-plan.js';
import type { VerificationResult } from '../../e2e/scenarios/types.js';

const MANIFEST = join(REPO_ROOT, 'services/observability/k8s/grafana-deployment.yaml');

describe("Grafana's startup allowance comes from its manifest", () => {
  it('is the startup probe budget plus one readiness period', () => {
    expect(grafanaStartupAllowanceSeconds()).toBe(2 * 150 + 10);
  });

  it('moves with the manifest, so the wait can never fall behind the product', () => {
    const text = readFileSync(MANIFEST, 'utf-8').replace(
      /failureThreshold: 150/,
      'failureThreshold: 300',
    );
    expect(grafanaStartupAllowanceSeconds(text)).toBe(2 * 300 + 10);
  });
});

describe('waitForGrafanaReady', () => {
  it("waits on the Deployment's rollout for the whole allowance, over SSH to the master", async () => {
    const exec = vi.fn(() => ({
      ok: true,
      output: 'deployment "grafana" successfully rolled out',
    }));
    const result = await waitForGrafanaReady('203.0.113.7', '/tmp/key', { exec });
    expect(result.status).toBe('pass');
    expect(result.checkName).toBe('grafana_ready');
    const [ip, key, remote, timeoutMs] = exec.mock.calls[0] as unknown as [
      string,
      string,
      string,
      number,
    ];
    expect([ip, key]).toEqual(['203.0.113.7', '/tmp/key']);
    expect(remote).toContain(
      `kubectl -n ${GRAFANA_NAMESPACE} rollout status deployment/grafana --timeout=310s`,
    );
    // The SSH call outlives kubectl's own timeout, so kubectl decides.
    expect(timeoutMs).toBeGreaterThan(310_000);
  });

  it('fails naming the allowance and the pods when Grafana never becomes Ready', async () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce({ ok: false, output: 'error: timed out waiting for the condition' })
      .mockReturnValueOnce({ ok: true, output: 'grafana-7f657f8b94-xcmz7   0/1   Running   2' });
    const result = await waitForGrafanaReady('203.0.113.7', '/tmp/key', { exec });
    expect(result.status).toBe('fail');
    expect(result.errorMessage).toMatch(/not Ready within its own startup allowance \(310 s\)/);
    expect(result.errorMessage).toContain('timed out waiting for the condition');
    expect(JSON.stringify(result.details)).toContain('grafana-7f657f8b94-xcmz7');
  });
});

describe('runPostReconvergeObservability waits for Grafana first', () => {
  const pass = (checkName: string): VerificationResult => ({ checkName, status: 'pass' });

  it('runs the outside checks only after Grafana is Ready', async () => {
    const order: string[] = [];
    const results = await runPostReconvergeObservability(
      { domain: 'd.example', adminEmail: 'a@example.test', adminPassword: 'pw' },
      {
        waitReady: async () => {
          order.push('ready');
          return pass('grafana_ready');
        },
        signIn: async () => {
          order.push('signIn');
          return { result: pass('auth_admin_login'), jar: {} };
        },
        runChecks: async () => {
          order.push('checks');
          return [pass('grafana_route_protected')];
        },
      },
    );
    expect(order).toEqual(['ready', 'signIn', 'checks']);
    expect(results.map((r) => r.checkName)).toEqual([
      'grafana_ready',
      'auth_admin_login',
      'grafana_route_protected',
    ]);
  });

  it('reports a Grafana that never became Ready instead of probing a route it cannot have', async () => {
    const runChecks = vi.fn(async () => [pass('grafana_route_protected')]);
    const results = await runPostReconvergeObservability(
      { domain: 'd.example', adminEmail: 'a@example.test', adminPassword: 'pw' },
      {
        waitReady: async () => ({
          checkName: 'grafana_ready',
          status: 'fail',
          errorMessage: 'not Ready',
        }),
        signIn: async () => ({ result: pass('auth_admin_login'), jar: {} }),
        runChecks,
      },
    );
    expect(results).toEqual([
      { checkName: 'grafana_ready', status: 'fail', errorMessage: 'not Ready' },
    ]);
    expect(runChecks).not.toHaveBeenCalled();
  });
});

describe('lifecycle wiring', () => {
  it('reconverge-deploy passes the Grafana wait on the reconverged primary', () => {
    const src = readRepoFile('tests/e2e/scenarios/_run-lifecycle.ts');
    const at = src.indexOf('runPostReconvergeObservability(');
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, at + 1500);
    expect(call).toMatch(/waitReady: \(\) => waitForGrafanaReady\(newPrimaryIp, sshKeyPath\)/);
  });
});
