import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autoscalerRepatchProblem,
  CA_REPATCH_FAILED,
  CA_REPATCHED,
} from '../../e2e/utils/scale-output.js';

const ok = (label: string) => `◆  cluster-autoscaler re-patched (${label}): worker-pool 0:2:cpx32`;
const failed = (label: string) => `◆  CA re-patch failed (${label})`;

describe('verify-scale: the autoscaler took the new worker settings', () => {
  it('k8s: one re-patch line passes', () => {
    expect(autoscalerRepatchProblem(ok('nbg1'), 'k8s')).toBeNull();
  });

  it('k8s-ha: needs both clusters', () => {
    expect(autoscalerRepatchProblem(ok('primary: nbg1'), 'k8s-ha')).toMatch(/expected 2.*saw 1/);
    expect(
      autoscalerRepatchProblem(`${ok('primary: nbg1')}\n${ok('standby: fsn1')}`, 'k8s-ha'),
    ).toBeNull();
  });

  it('a failed re-patch fails, naming the cluster (the 2026-11-13 hetzner/k8s-ha standby)', () => {
    const out = `${ok('primary: nbg1')}\n${failed('standby: fsn1')}\n${ok('standby: fsn1')}`;
    expect(autoscalerRepatchProblem(out, 'k8s-ha')).toMatch(/standby: fsn1.*re-patch failed/);
  });

  it('no re-patch at all fails (a skipped re-patch is not a pass)', () => {
    expect(autoscalerRepatchProblem('Scaling all node roles', 'k8s')).toMatch(/saw 0/);
  });

  it('compose modes have no autoscaler', () => {
    expect(autoscalerRepatchProblem('', 'compose')).toBeNull();
    expect(autoscalerRepatchProblem('', 'compose-ha')).toBeNull();
  });

  it('matches the lines src/scale.js prints', () => {
    const src = readFileSync(join(process.cwd(), 'src/scale.js'), 'utf-8');
    expect(src).toMatch(/`cluster-autoscaler re-patched \(\$\{label\}\): worker-pool/);
    expect(src).toMatch(/`CA re-patch failed \(\$\{label\}\)`/);
    expect([...ok('x').matchAll(CA_REPATCHED)]).toHaveLength(1);
    expect([...failed('x').matchAll(CA_REPATCH_FAILED)]).toHaveLength(1);
  });

  it('verify-scale runs the check', () => {
    const src = readFileSync(join(process.cwd(), 'tests/e2e/scenarios/_run-lifecycle.ts'), 'utf-8');
    const verify = src.slice(src.indexOf("name: 'verify-scale',"));
    const body = verify.slice(0, verify.indexOf('// 2. Type-comparison path'));
    expect(body).toMatch(/autoscalerRepatchProblem\(combined, config\.mode\)/);
  });
});
