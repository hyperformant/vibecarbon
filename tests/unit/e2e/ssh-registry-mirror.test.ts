import { describe, expect, it } from 'vitest';
import { extractRegistryMirrorAddress } from '../../e2e/utils/ssh.js';

/**
 * Regression coverage for the k8s failure-diagnostics registry probe
 * (tests/e2e/scenarios/_run-lifecycle.ts): it used to curl a hardcoded
 * `10.0.1.1:5000` regardless of provider, which is a dead address on
 * DigitalOcean (dynamically-assigned VPC private IPs, no static pin like
 * Hetzner). extractRegistryMirrorAddress reads the SAME registries.yaml
 * both providers' cloud-init writes (carbon/cloud-init/k3s/master-init.sh
 * and do-master-init.sh) instead of hardcoding either provider's shape.
 */
describe('extractRegistryMirrorAddress', () => {
  it("extracts Hetzner static address unchanged (regression pin — today's probe target)", () => {
    const yaml = `mirrors:
  "10.0.1.1:5000":
    endpoint:
      - "http://10.0.1.1:5000"
`;
    expect(extractRegistryMirrorAddress(yaml)).toBe('10.0.1.1:5000');
  });

  it('extracts a DigitalOcean runtime-resolved VPC address', () => {
    const yaml = `mirrors:
  "10.10.0.5:5000":
    endpoint:
      - "http://10.10.0.5:5000"
`;
    expect(extractRegistryMirrorAddress(yaml)).toBe('10.10.0.5:5000');
  });

  it('returns null for missing registries.yaml (the ssh() fallback text)', () => {
    expect(extractRegistryMirrorAddress('(no registries.yaml)')).toBeNull();
  });

  it('returns null for an ssh-failure string piped in as content', () => {
    expect(extractRegistryMirrorAddress('(ssh to 1.2.3.4 failed: connect ETIMEDOUT)')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(extractRegistryMirrorAddress('')).toBeNull();
  });
});
