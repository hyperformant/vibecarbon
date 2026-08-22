/**
 * The failure bundle must capture the in-cluster registry's own logs.
 *
 * `local-registry` is `registry:2` with an S3 storage backend. When that
 * backend errors, the registry answers `docker push` with HTTP 500 — but its
 * readiness probe hits `/v2/`, which keeps succeeding. The pod therefore stays
 * `1/1 Running` throughout, and the bundle's log collector only dumps logs for
 * NOT-READY pods. Net effect: the one process that knows why the push failed
 * is the one process we never ask.
 *
 * That is why the registry-500 flake has never been root-caused. It hit
 * hetzner/k8s in run 31763728135 and hetzner/k8s-ha restore in 31857911325
 * (five consecutive 500s, then `blob upload unknown`), and in the second
 * bundle the registry appears only as a `1/1 Running` line in the pod table.
 *
 * These logs are collected unconditionally — readiness is not evidence of
 * health for this workload.
 */

import { describe, expect, it } from 'vitest';
import { buildClusterScopedDiagnostics } from '../../../tests/e2e/utils/cluster-diagnostics.js';

const KUBECONFIG = '/tmp/kubeconfig-ci4-primary';

describe('cluster diagnostics: local-registry', () => {
  const cmds = buildClusterScopedDiagnostics(KUBECONFIG, 'kubeconfig-ci4-primary');
  const registryCmd = cmds.find((c) => /local-registry/i.test(c.label));

  it('collects local-registry logs', () => {
    expect(registryCmd).toBeDefined();
  });

  it('selects the registry by label rather than by readiness', () => {
    const argv = JSON.stringify(registryCmd?.argv ?? []);
    expect(argv).toContain('app=local-registry');
    expect(argv).toContain('logs');
  });

  it('is not gated on the not-Ready pod expression', () => {
    // The whole point: a Ready-but-erroring registry must still be dumped.
    // `field-selector=status.phase` is how notReadyPodsExpr narrows pods.
    const argv = JSON.stringify(registryCmd?.argv ?? []);
    expect(argv).not.toContain('field-selector');
  });

  it('fetches deep and filters probe noise so the error window survives the tail', () => {
    // Run 31961619204 (k8s-ha registry-500, third occurrence of the class):
    // the collector fired and STILL lost the evidence — a 50-line raw tail
    // held only post-failure kube-probe chatter (~17 lines/min of it), while
    // the 18:43–18:47 push errors had rotated out by the 18:53 capture. The
    // fix is condition-shaped, not a bigger number alone: fetch deep, then
    // keep SUBSTANCE by dropping probe lines (both the access-log and
    // structured forms carry the literal "kube-probe") before the final tail.
    const argv = (registryCmd?.argv ?? []).join(' ');
    const fetchTail = argv.match(/--tail=(\d+)/);
    expect(Number(fetchTail?.[1] ?? 0)).toBeGreaterThanOrEqual(2000);
    expect(argv).toContain('grep -v kube-probe');
    const keeps = argv.match(/tail -(\d+)/g) ?? [];
    const finalKeep = Number(keeps.at(-1)?.match(/\d+/)?.[0] ?? 0);
    expect(finalKeep).toBeGreaterThanOrEqual(300);
  });

  it('targets the kubeconfig it was asked about', () => {
    // In k8s-ha this builder runs once per cluster (primary and standby), so a
    // hardcoded kubeconfig would silently dump the same cluster twice.
    expect(JSON.stringify(registryCmd?.argv ?? [])).toContain(KUBECONFIG);
  });
});
