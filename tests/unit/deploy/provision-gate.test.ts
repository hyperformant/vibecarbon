/**
 * `isProvisioningDeploy` decides whether a `vibecarbon deploy` invocation is
 * PROVISIONING a new paid environment (which consults the license) or
 * REdeploying one that already exists (which never does).
 *
 * The signal is the persisted envConfig, read at the moment the gate fires —
 * after resolveProvider, before the skeleton save that first persists
 * `deployMode`. So:
 *   - no deployMode at all  -> brand-new environment, provisioning
 *   - status 'deploying'    -> a first deploy that never finished; the
 *                              skeleton save already wrote deployMode, but
 *                              nothing was successfully provisioned yet, so
 *                              a resume is still provisioning
 *   - deployMode + any other status -> an existing environment, free
 */

import { describe, expect, it } from 'vitest';
import { isProvisioningDeploy } from '../../../src/lib/deploy/prompts.js';

describe('isProvisioningDeploy', () => {
  it('treats an empty envConfig as provisioning', () => {
    expect(isProvisioningDeploy({})).toBe(true);
  });

  it('treats a deployed environment as a redeploy', () => {
    expect(isProvisioningDeploy({ deployMode: 'compose', status: 'deployed' })).toBe(false);
  });

  it('treats a resumed first deploy (status: deploying) as provisioning', () => {
    expect(isProvisioningDeploy({ deployMode: 'kubernetes', status: 'deploying' })).toBe(true);
  });

  it('treats a status-only envConfig with no deployMode as provisioning', () => {
    expect(isProvisioningDeploy({ status: 'deployed' })).toBe(true);
  });

  it('fails closed on a missing envConfig', () => {
    expect(isProvisioningDeploy(undefined)).toBe(true);
    expect(isProvisioningDeploy(null)).toBe(true);
  });

  it('treats an HA environment that has been deployed as a redeploy', () => {
    expect(
      isProvisioningDeploy({ deployMode: 'kubernetes', ha: { enabled: true }, status: 'deployed' }),
    ).toBe(false);
  });
});
