import { describe, expect, it } from 'vitest';
import { planDeploy } from '../../../../src/lib/deploy/plan/deploy-plan.js';
import { planStepNames } from '../../../../src/lib/deploy/plan/step.js';

// Behavior-identity lock. This snapshot pins the compose deploy step-name
// sequence so any future edit to the planner (or an accidental reorder /
// dropped step) fails loudly in review rather than silently regressing the
// deploy. Update it ONLY with an intentional, reviewed change to the plan.
describe('compose deploy plan snapshot', () => {
  it('locks the compose step-name sequence', () => {
    expect(planStepNames(planDeploy('compose', {}))).toMatchInlineSnapshot(`
      [
        "provision-server",
        "setup-server",
        "transfer-image",
        "dockerhub-login",
        "ghcr-login",
        "setup-server-files",
        "update-dns",
        "start-compose-stack",
        "run-migrations",
        "create-admin-user",
        "verify-health",
        "verify-tls",
        "setup-backup-cron",
      ]
    `);
  });

  it('locks the compose-ha step-name sequence', () => {
    expect(planStepNames(planDeploy('compose-ha', {}))).toMatchInlineSnapshot(`
      [
        "provision-servers",
        "persist-pending-config",
        "wait-for-ssh",
        "seed-known-hosts",
        "setup-servers",
        "wait-docker-ready",
        "remote-build",
        "setup-server-files",
        "merge-walg-role",
        "pull-images",
        "update-dns",
        "start-compose-stack",
        "run-migrations",
        "create-admin-user",
        "wait-primary-postgres",
        "write-replication-overlay",
        "configure-replication",
        "verify-streaming",
        "verify-tls",
        "setup-backup-cron",
        "finalize-config",
      ]
    `);
  });

  it('locks the k8s step-name sequence', () => {
    expect(planStepNames(planDeploy('k8s', {}))).toMatchInlineSnapshot(`
      [
        "deploy-cluster",
      ]
    `);
  });

  it('locks the k8s-ha step-name sequence', () => {
    expect(planStepNames(planDeploy('k8s-ha', {}))).toMatchInlineSnapshot(`
      [
        "generate-ssh-key",
        "upload-ssh-key",
        "provision-clusters",
        "open-replication-firewall",
        "configure-replication",
        "verify-streaming",
        "update-dns",
        "finalize",
      ]
    `);
  });
});
