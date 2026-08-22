/**
 * Unit tests for the cluster-scoped half of the e2e failure-diagnostics
 * bundle (tests/e2e/utils/cluster-diagnostics.ts).
 *
 * Motivation — two blind RCAs, both because the bundle was namespace-blind:
 *
 *  - 2026-07-27: a cluster-scoped deploy failure produced a bundle that
 *    covered only the `vibecarbon` namespace (logged as carbon-autoscaler
 *    a carbon-autoscaler follow-up).
 *  - 2026-07-31 (k8s e3): deploy died on "cluster-autoscaler rollout status
 *    failed (timeout 300s)". cluster-autoscaler runs in kube-system, and the
 *    bundle had zero kube-system state — ImagePullBackOff, CrashLoopBackOff
 *    and plain slow-start were indistinguishable after the fact.
 */
import { describe, expect, it } from 'vitest';
import type { StepName } from '../../e2e/scenarios/types.js';
import {
  buildClusterScopedDiagnostics,
  CLUSTER_DIAG_EVENT_TAIL,
  CLUSTER_DIAG_LOG_TAIL,
  CLUSTER_DIAG_MAX_PODS,
  CLUSTER_DIAG_NAMESPACES,
  isClusterScopedStep,
} from '../../e2e/utils/cluster-diagnostics.js';

const KC = '/tmp/proj/.vibecarbon/kubeconfig-e3';
const LABEL = 'kubeconfig-e3';

describe('isClusterScopedStep', () => {
  it('treats deploy/scale/restore (and their variants) as cluster-scoped', () => {
    for (const step of [
      'deploy',
      'warm-deploy',
      'reconverge-deploy',
      'scale',
      'restore',
      'failover',
    ] as StepName[]) {
      expect(isClusterScopedStep(step)).toBe(true);
    }
  });

  it('leaves app-level steps on the narrow (app-namespace) bundle', () => {
    for (const step of [
      'create',
      'setup-repo',
      'add-features',
      'verify-deploy',
      'verify-load',
      'backup',
      'destroy',
      'teardown-repo',
    ] as StepName[]) {
      expect(isClusterScopedStep(step)).toBe(false);
    }
  });
});

describe('buildClusterScopedDiagnostics', () => {
  const cmds = buildClusterScopedDiagnostics(KC, LABEL);
  const scripts = cmds.map((c) => c.argv.join(' '));
  const all = scripts.join('\n');

  it('captures cluster-wide pod state', () => {
    expect(
      cmds.some(
        (c) =>
          c.cmd === 'kubectl' &&
          c.argv.join(' ').includes('get pods -A -o wide') &&
          c.argv.includes(KC),
      ),
    ).toBe(true);
  });

  it('captures cluster-wide events, tail-bounded', () => {
    const events = scripts.find((s) => s.includes('get events -A'));
    expect(events).toBeDefined();
    expect(events).toContain('--sort-by=.lastTimestamp');
    expect(events).toContain(`tail -${CLUSTER_DIAG_EVENT_TAIL}`);
  });

  it('covers kube-system AND the app namespace with describe + logs', () => {
    for (const ns of CLUSTER_DIAG_NAMESPACES) {
      const nsScripts = scripts.filter((s) => s.includes(`-n ${ns} `));
      expect(nsScripts.some((s) => s.includes('describe pod'))).toBe(true);
      expect(nsScripts.some((s) => s.includes('logs'))).toBe(true);
    }
    expect(CLUSTER_DIAG_NAMESPACES).toContain('kube-system');
    expect(CLUSTER_DIAG_NAMESPACES).toContain('vibecarbon');
  });

  it('selects NOT-READY pods, not just not-Running ones', () => {
    // A Running pod with a dead sidecar (1/2 Ready, 0 restarts) is exactly the
    // shape the CA rollout timeout produced — the pre-existing app-namespace
    // sections filter on STATUS!=Running or RESTARTS>0 and miss it.
    expect(all).toContain('split($2,r,"/")');
    expect(all).toMatch(/r\[1\]\s*\+\s*0\s*<\s*r\[2\]\s*\+\s*0/);
  });

  it('captures BOTH --previous and current logs for each not-ready pod', () => {
    for (const ns of CLUSTER_DIAG_NAMESPACES) {
      // Select by the NOT-READY fan-out marker (`bad=$(`), not merely by
      // "mentions logs" — the bundle also collects local-registry logs via a
      // label selector, and a looser find() picks that up instead.
      const logScript = scripts.find(
        (s) => s.includes(`-n ${ns} `) && s.includes('logs') && s.includes('bad=$('),
      );
      expect(logScript).toBeDefined();
      expect(logScript).toContain('--previous');
      expect(logScript).toContain('--all-containers');
      expect(logScript).toContain(`--tail=${CLUSTER_DIAG_LOG_TAIL}`);
    }
  });

  it('bounds the pod fan-out and every per-pod command', () => {
    // Only fan-out scripts need the cap: they iterate NOT-READY pods. A
    // single label-selected collector (local-registry logs) has no fan-out.
    for (const script of scripts.filter((s) => s.includes('bad=$('))) {
      expect(script).toContain(`head -${CLUSTER_DIAG_MAX_PODS}`);
    }
    // But EVERY pod-reading kubectl is timeout-wrapped, fan-out or not, so one
    // wedged pod can't starve the rest of the bundle.
    for (const script of scripts.filter((s) => s.includes('describe pod') || s.includes('logs'))) {
      expect(script).toContain('timeout ');
    }
    for (const c of cmds) expect(c.timeoutMs).toBeGreaterThan(0);
  });

  it('threads the kubeconfig into every command (no ambient KUBECONFIG)', () => {
    for (const c of cmds) expect(c.argv.join(' ')).toContain(KC);
  });

  it('labels every section with the kubeconfig it came from', () => {
    for (const c of cmds) {
      expect(c.label).toContain(LABEL);
      expect(c.label.length).toBeGreaterThan(LABEL.length);
    }
  });

  it('shells out through bash -c for the multi-step scripts, matching house style', () => {
    for (const c of cmds) {
      expect(['kubectl', 'bash']).toContain(c.cmd);
      if (c.cmd === 'bash') expect(c.argv[0]).toBe('-c');
    }
  });
});

describe('lifecycle wiring', () => {
  it('_run-lifecycle gates the cluster-scoped bundle on isClusterScopedStep', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('buildClusterScopedDiagnostics');
    expect(src).toContain('isClusterScopedStep(stepName)');
  });
});
