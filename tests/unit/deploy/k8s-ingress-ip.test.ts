import { describe, expect, it } from 'vitest';
import { clusterIngressIp } from '../../../src/lib/deploy/k8s/ingress-ip.js';

/**
 * The address a k8s cluster's records point at, for every reader (both DNS
 * writers, the success save, failover's flip, the completion summary).
 */
describe('clusterIngressIp', () => {
  it('Hetzner and Linode: the floating IP, over the master', () => {
    expect(clusterIngressIp({ masterIp: '198.51.100.7', floatingIp: '203.0.113.9' })).toBe(
      '203.0.113.9',
    );
  });

  it("DigitalOcean: the master's own address", () => {
    expect(clusterIngressIp({ masterIp: '198.51.100.7' })).toBe('198.51.100.7');
  });

  it('a persisted record: its own ingressIp first, over a retired reserved IP still on record', () => {
    expect(
      clusterIngressIp({
        masterIp: '198.51.100.7',
        ingressIp: '198.51.100.7',
        floatingIp: '203.0.113.9',
      }),
    ).toBe('198.51.100.7');
  });

  it('a record saved before ingressIp existed: its floating IP, then its master', () => {
    expect(clusterIngressIp({ floatingIp: '203.0.113.9' })).toBe('203.0.113.9');
    expect(clusterIngressIp({ masterIp: '198.51.100.7' })).toBe('198.51.100.7');
  });

  it('nothing known: null', () => {
    expect(clusterIngressIp({})).toBeNull();
    expect(clusterIngressIp(undefined)).toBeNull();
    expect(clusterIngressIp(null)).toBeNull();
  });
});
