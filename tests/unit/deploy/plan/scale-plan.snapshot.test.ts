import { describe, expect, it } from 'vitest';
import { planScale } from '../../../../src/lib/deploy/plan/scale-plan.js';
import { planStepNames } from '../../../../src/lib/deploy/plan/step.js';

// Behavior-identity lock for `scale`. These snapshots pin the per-tier
// step-name sequence so any future edit that reorders the blue-green
// replacement, drops the master-replace defense's re-patch tail, or changes
// the HA fan-out fails loudly in review instead of silently drifting.
// Update ONLY with an intentional, reviewed plan change.
describe('scale plan snapshot', () => {
  it('locks the compose scale step-name sequence', () => {
    expect(planStepNames(planScale('compose', {}))).toMatchInlineSnapshot(`
      [
        "register-ssh-key",
        "scale-servers",
        "update-project-config",
        "finish-outro",
      ]
    `);
  });

  it('locks the compose-ha scale step-name sequence', () => {
    expect(planStepNames(planScale('compose-ha', {}))).toMatchInlineSnapshot(`
      [
        "register-ssh-key",
        "scale-servers",
        "update-project-config",
        "finish-outro",
      ]
    `);
  });

  it('locks the k8s scale step-name sequence', () => {
    expect(planStepNames(planScale('k8s', {}))).toMatchInlineSnapshot(`
      [
        "apply-scale-changes",
        "re-establish-ha-tunnel",
        "verify-ready",
        "update-project-config",
        "finish-outro",
      ]
    `);
  });

  it('locks the k8s-ha scale step-name sequence', () => {
    expect(planStepNames(planScale('k8s-ha', {}))).toMatchInlineSnapshot(`
      [
        "apply-scale-changes",
        "re-establish-ha-tunnel",
        "verify-ready",
        "update-project-config",
        "finish-outro",
      ]
    `);
  });
});
