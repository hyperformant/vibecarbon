import { describe, expect, it } from 'vitest';
import {
  findNonZeroReplicaDeployments,
  PILOT_KEPT_DEPLOYMENTS,
} from '../../e2e/checks/pilot-light.js';

/**
 * The pilot-light standby keeps exactly the floor it needs. repl-gateway is
 * one: the standby db replicates through it (standby gateway -> wg0 ->
 * primary gateway), and #235 turned it from a bare Pod into a Deployment, so
 * the check began counting it (DO k8s-ha e2e, 2026-10-31: verify-deploy
 * failed on the deploy's correct state). The short-lived registry relay is
 * not: one still running at verify time is a leak.
 */
describe('pilot-light kept deployments', () => {
  const dep = (name: string, replicas: number) => ({ name, replicas });

  it('keeps traefik, the local registry and repl-gateway running', () => {
    expect(
      findNonZeroReplicaDeployments([
        dep('traefik', 1),
        dep('local-registry', 1),
        dep('repl-gateway', 1),
        dep('app', 0),
      ]),
    ).toEqual([]);
  });

  it('still flags the app, add-ons and a leftover registry relay', () => {
    expect(
      findNonZeroReplicaDeployments([
        dep('app', 1),
        dep('n8n', 1),
        dep('registry-relay', 1),
        dep('repl-gateway', 1),
      ]),
    ).toEqual(['app', 'n8n', 'registry-relay']);
  });

  it('names repl-gateway in the kept list', () => {
    expect(PILOT_KEPT_DEPLOYMENTS).toContain('repl-gateway');
  });
});
