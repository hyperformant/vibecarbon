/**
 * deployK3s attributes every stage between the k3s ready wait and the
 * manifest apply to one perf span, so a run's `[perf]` lines account for the
 * whole arm. Before, about 94 s of the DO tor1 standby arm sat in unwrapped
 * stages: the host-key scan, the kubeconfig copy, the control-plane gate and
 * the restore-marker read (run 44b4f77f).
 *
 * The control-plane gate here is the deploy's only one: applyK3sManifests
 * runs right after it, with nothing in between that touches k3s, so the
 * apply no longer probes again (k3s-apply-manifests-ordering.test.ts).
 *
 * Source-level: deployK3s needs Pulumi, ssh and a cluster to run, so this
 * reads its body. The spans inside applyK3sManifests are proven by running it
 * (k3s-apply-manifests-ordering.test.ts, "perf markers").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const K3S = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');
const BODY = K3S.slice(K3S.indexOf('async function deployK3sSteps('));

/** Source text containing template placeholders, written as `#{...}`. */
const tpl = (s: string) => s.replaceAll('#{', '$' + '{');

/** The text of `perfAsync(\`deploy.${perfPrefix}.<name>\`, ...)`, balanced to its closing paren. */
function span(name: string): { at: number; text: string } {
  const open = tpl(`perfAsync(\`deploy.#{perfPrefix}.${name}\``);
  const at = BODY.indexOf(open);
  expect(at, `span ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = at + 'perfAsync'.length; i < BODY.length; i++) {
    if (BODY[i] === '(') depth++;
    else if (BODY[i] === ')' && --depth === 0) return { at, text: BODY.slice(at, i + 1) };
  }
  throw new Error(`unbalanced span ${name}`);
}

describe('deployK3s perf spans', () => {
  it('each stage sits inside its own span', () => {
    expect(span('hostKeys').text).toMatch(/Promise\.all\([\s\S]*seedKnownHosts\(khPath, ip\)/);
    expect(span('kubeconfig').text).toContain('fetchKubeconfig(');
    expect(span('controlPlane.gate').text).toContain('awaitControlPlaneServing({ env: kubeEnv })');
    expect(span('restoreMarker').text).toContain('assertRestoreMarkerState(');
    expect(span('image.ready').text).toContain('deliverAppImage(');
  });

  it('in deploy order, from the ready wait to the manifest apply', () => {
    const order = [
      'waitForReady',
      'hostKeys',
      'kubeconfig',
      'controlPlane.gate',
      'restoreMarker',
      'image.ready',
      'applyManifests',
    ].map((name) => span(name).at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('the control-plane gate runs on every deploy, outside the step gates', () => {
    // A skipped k3s-apply must not skip it: the restore marker read needs a
    // serving apiserver, and so does everything applyK3sManifests does.
    const gate = span('controlPlane.gate').at;
    const kubeconfigStep = BODY.indexOf("state.completeStep('k3s-kubeconfig'");
    const applyStep = BODY.indexOf("state.startStep('k3s-apply'");
    expect(gate).toBeGreaterThan(kubeconfigStep);
    expect(gate).toBeLessThan(applyStep);
    const between = BODY.slice(kubeconfigStep, gate);
    expect(between).not.toMatch(/if \(!state\.shouldSkip\(/);
  });

  it('applyK3sManifests does not probe the control plane itself', () => {
    const apply = K3S.slice(
      K3S.indexOf('export async function applyK3sManifests('),
      K3S.indexOf('async function deployK3sSteps('),
    );
    expect(apply).not.toContain('awaitControlPlaneServing(');
  });
});
