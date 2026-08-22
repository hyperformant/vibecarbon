import { describe, expect, it } from 'vitest';
import { planDestroy } from '../../../../src/lib/deploy/plan/destroy-plan.js';
import { planStepNames } from '../../../../src/lib/deploy/plan/step.js';

// Behavior-identity lock for the SAFETY-CRITICAL destroy path. These snapshots
// pin the per-tier teardown step-name sequence so any future edit that reorders
// a teardown, drops the state-bucket-last guard, or changes the HA fan-out
// fails loudly in review rather than silently orphaning or wrongly deleting
// real infrastructure. Update ONLY with an intentional, reviewed plan change.
describe('destroy plan snapshot', () => {
  it('locks the compose teardown step-name sequence', () => {
    expect(planStepNames(planDestroy('compose', {}))).toMatchInlineSnapshot(`
      [
        "destroy-compose-services",
        "remove-stack-state",
        "delete-app-bucket",
        "retain-state-bucket",
        "handle-backup-bucket",
        "update-project-config",
        "cleanup-local-files",
        "finish-outro",
      ]
    `);
  });

  it('locks the compose-ha teardown step-name sequence', () => {
    expect(planStepNames(planDestroy('compose-ha', {}))).toMatchInlineSnapshot(`
      [
        "destroy-compose-ha",
        "remove-stack-state",
        "delete-app-bucket",
        "retain-state-bucket",
        "handle-backup-bucket",
        "update-project-config",
        "cleanup-local-files",
        "finish-outro",
      ]
    `);
  });

  it('locks the k8s teardown step-name sequence', () => {
    expect(planStepNames(planDestroy('k8s', {}))).toMatchInlineSnapshot(`
      [
        "destroy-k8s-infra",
        "delete-app-bucket",
        "retain-state-bucket",
        "handle-backup-bucket",
        "delete-github-env",
        "update-project-config",
        "cleanup-local-files",
        "print-summary",
        "finish-outro",
      ]
    `);
  });

  it('locks the k8s-ha teardown step-name sequence', () => {
    expect(planStepNames(planDestroy('k8s-ha', {}))).toMatchInlineSnapshot(`
      [
        "destroy-k8s-infra",
        "delete-app-bucket",
        "retain-state-bucket",
        "handle-backup-bucket",
        "delete-github-env",
        "update-project-config",
        "cleanup-local-files",
        "print-summary",
        "finish-outro",
      ]
    `);
  });
});
