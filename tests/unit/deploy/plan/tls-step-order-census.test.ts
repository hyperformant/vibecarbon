/**
 * Every deploy tier that starts a compose stack restores the last issued
 * certificate before Traefik starts (after the bundle, with its reconcile.sh
 * and .env, is on the server) and saves a fresh snapshot once TLS is trusted.
 * The walk drafts any future compose tier automatically.
 */
import { describe, expect, it } from 'vitest';
import { planDeploy } from '../../../../src/lib/deploy/plan/deploy-plan.js';

describe('tls restore/snapshot step order census', () => {
  let checked = 0;
  for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
    const names = planDeploy(tier, {}).map((s) => s.name);
    if (!names.includes('start-compose-stack')) continue;
    checked += 1;
    it(`${tier}: restore-tls after setup-server-files and before start-compose-stack; snapshot-tls after verify-tls`, () => {
      expect(names.filter((n) => n === 'restore-tls')).toHaveLength(1);
      expect(names.filter((n) => n === 'snapshot-tls')).toHaveLength(1);
      expect(names.indexOf('restore-tls')).toBeGreaterThan(names.indexOf('setup-server-files'));
      expect(names.indexOf('restore-tls')).toBeLessThan(names.indexOf('start-compose-stack'));
      expect(names.indexOf('snapshot-tls')).toBeGreaterThan(names.indexOf('verify-tls'));
    });
  }

  it('checked at least the two compose tiers (the census cannot go hollow)', () => {
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
