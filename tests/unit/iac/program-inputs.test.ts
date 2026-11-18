import { describe, expect, it } from 'vitest';
import {
  requireOperatorCidrs,
  sshKeyIdOutput,
  stackIdentity,
} from '../../../src/lib/iac/program-inputs.js';

/**
 * The preamble the Pulumi programs share. Every program used to spell these
 * out; the stack name, the label order and the two refusals must read
 * exactly as they did, since the labels land on live resources and the
 * refusals are matched by callers and tests.
 */
describe('stackIdentity', () => {
  it('names the stack <project>-<environment> and puts ownership before the caller labels', () => {
    const { name, labels } = stackIdentity({
      projectName: 'shop',
      environment: 'prod',
      labels: { role: 'compose' },
    });
    expect(name).toBe('shop-prod');
    expect(Object.entries(labels)).toEqual([
      ['project', 'shop'],
      ['environment', 'prod'],
      ['managed-by', 'vibecarbon'],
      ['role', 'compose'],
    ]);
  });

  it('takes no caller labels as none', () => {
    expect(stackIdentity({ projectName: 'shop', environment: 'dev' }).labels).toEqual({
      project: 'shop',
      environment: 'dev',
      'managed-by': 'vibecarbon',
    });
  });
});

describe('requireOperatorCidrs', () => {
  const ssh = ['203.0.113.7/32'];

  it('refuses no SSH allowlist with the message the programs always threw', () => {
    expect(() => requireOperatorCidrs({ allowedSshIps: [] })).toThrow(
      new Error(
        'allowedSshIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
      ),
    );
  });

  it('asks for the k8s API allowlist only when told to, and after the SSH one', () => {
    expect(() => requireOperatorCidrs({ allowedSshIps: ssh })).not.toThrow();
    expect(() => requireOperatorCidrs({ allowedSshIps: ssh }, { k8sApi: true })).toThrow(
      new Error(
        'allowedK8sApiIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
      ),
    );
    expect(() => requireOperatorCidrs({}, { k8sApi: true })).toThrow(/^allowedSshIps required/);
    expect(() =>
      requireOperatorCidrs({ allowedSshIps: ssh, allowedK8sApiIps: ssh }, { k8sApi: true }),
    ).not.toThrow();
  });
});

describe('sshKeyIdOutput', () => {
  it('passes an existing key id through and stringifies a created one', () => {
    expect(sshKeyIdOutput('12345')).toBe('12345');
    const output = { apply: (fn: (id: unknown) => string) => fn(678) };
    expect(sshKeyIdOutput(output)).toBe('678');
  });
});
