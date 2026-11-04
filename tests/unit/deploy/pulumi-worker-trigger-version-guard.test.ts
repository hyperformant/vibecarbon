/**
 * The Pulumi-too-old guard for k8s deploys.
 *
 * Static k8s workers ignore their user data and are rebuilt through a
 * `replacementTrigger` holding their join target (workerResourceOptions in
 * src/lib/iac/create-timeout.js). Pulumi added that option in v3.208.0 and
 * fixed it firing on dependency changes in v3.226.0; an older CLI drops it
 * without a word, and a replaced master would then leave the static workers
 * joining a master that is gone. The CLI is the operator's (on PATH, not an
 * npm dependency), so the deploy preflight refuses an old one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertPulumiSupportsWorkerJoinTrigger,
  checkDeployPrerequisites,
  PULUMI_MIN_VERSION_FOR_WORKER_JOIN_TRIGGER,
} from '../../../src/lib/deploy/preflight.js';

const has = () => true;
const atLeast = (v: string, min: string) => {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe('assertPulumiSupportsWorkerJoinTrigger', () => {
  it('the floor is the release that fixed the trigger firing on dependency changes', () => {
    expect(atLeast(PULUMI_MIN_VERSION_FOR_WORKER_JOIN_TRIGGER, '3.226.0')).toBe(true);
  });

  it.each(['k8s', 'k8s-ha'])(
    'refuses an older CLI on %s, naming the version and the fix',
    (tier) => {
      let message = '';
      try {
        assertPulumiSupportsWorkerJoinTrigger(tier, '3.207.0');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/Pulumi 3\.207\.0 is too old/);
      expect(message).toContain(`v${PULUMI_MIN_VERSION_FOR_WORKER_JOIN_TRIGGER}`);
      expect(message).toContain('curl -fsSL https://get.pulumi.com | sh');
      expect(message).not.toContain('—');
      // 3.225.x has the option but not the fix.
      expect(() => assertPulumiSupportsWorkerJoinTrigger(tier, '3.225.9')).toThrow();
    },
  );

  it.each([
    ['k8s', '3.226.0'],
    ['k8s-ha', '3.273.0'],
    ['k8s', null],
    ['compose', '3.100.0'],
    ['compose-ha', '3.100.0'],
  ])('lets %s through on %s', (tier, version) => {
    expect(() => assertPulumiSupportsWorkerJoinTrigger(tier, version)).not.toThrow();
  });
});

describe('checkDeployPrerequisites runs the gate', () => {
  it('refuses a k8s deploy on an old CLI before anything is provisioned', () => {
    expect(() =>
      checkDeployPrerequisites('k8s-ha', { has, pulumiVersion: () => '3.200.0' }),
    ).toThrow(/too old for a Kubernetes deploy/);
  });

  it('reads the version once for k8s, and never for a compose tier with a silent provider', () => {
    const pulumiVersion = vi.fn(() => '3.273.0');
    checkDeployPrerequisites('k8s', { has, pulumiVersion });
    expect(pulumiVersion).toHaveBeenCalledTimes(1);
    pulumiVersion.mockClear();
    checkDeployPrerequisites('compose', { has, pulumiVersion });
    expect(pulumiVersion).not.toHaveBeenCalled();
  });

  it('the Pulumi CI installs (the lockfile SDK version) clears the floor', () => {
    // test.yml installs the CLI at exactly the @pulumi/pulumi SDK version.
    const sdk = JSON.parse(
      readFileSync(join(process.cwd(), 'node_modules/@pulumi/pulumi/package.json'), 'utf-8'),
    ).version as string;
    expect(atLeast(sdk, PULUMI_MIN_VERSION_FOR_WORKER_JOIN_TRIGGER), sdk).toBe(true);
  });
});
