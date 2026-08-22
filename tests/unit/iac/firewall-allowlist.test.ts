import { describe, expect, it } from 'vitest';
import { buildHetznerComposeProgram } from '../../../src/lib/iac/programs/hetzner-compose.js';
import { buildHetznerK8sProgram } from '../../../src/lib/iac/programs/hetzner-k8s.js';

const baseK8sConfig = {
  projectName: 'p',
  environment: 'e',
  sshPublicKey: 'ssh-ed25519 AAAA',
  location: 'fsn1',
  masterServerType: 'cx23',
  supabaseServerType: 'cx23',
  workerServerType: 'cx23',
  minWorkers: 0,
  maxWorkers: 0,
  k3sVersion: 'v1.31.0+k3s1',
  apiToken: 'tok',
  labels: {},
};

const baseComposeConfig = {
  projectName: 'p',
  environment: 'e',
  sshPublicKey: 'ssh-ed25519 AAAA',
  location: 'fsn1',
  serverType: 'cx23',
  labels: {},
};

describe('buildHetznerK8sProgram firewall allowlist guards (H-2)', () => {
  it('throws when allowedSshIps is omitted', () => {
    expect(() =>
      buildHetznerK8sProgram({ ...baseK8sConfig, allowedK8sApiIps: ['1.2.3.4/32'] }),
    ).toThrow(/allowedSshIps required/);
  });

  it('throws when allowedSshIps is empty', () => {
    expect(() =>
      buildHetznerK8sProgram({
        ...baseK8sConfig,
        allowedSshIps: [],
        allowedK8sApiIps: ['1.2.3.4/32'],
      }),
    ).toThrow(/allowedSshIps required/);
  });

  it('throws when allowedK8sApiIps is omitted', () => {
    expect(() =>
      buildHetznerK8sProgram({ ...baseK8sConfig, allowedSshIps: ['1.2.3.4/32'] }),
    ).toThrow(/allowedK8sApiIps required/);
  });

  it('throws when allowedK8sApiIps is empty', () => {
    expect(() =>
      buildHetznerK8sProgram({
        ...baseK8sConfig,
        allowedSshIps: ['1.2.3.4/32'],
        allowedK8sApiIps: [],
      }),
    ).toThrow(/allowedK8sApiIps required/);
  });

  it('returns a program when both lists are populated', () => {
    const program = buildHetznerK8sProgram({
      ...baseK8sConfig,
      allowedSshIps: ['1.2.3.4/32'],
      allowedK8sApiIps: ['1.2.3.4/32'],
    });
    expect(typeof program).toBe('function');
  });
});

describe('buildHetznerComposeProgram firewall allowlist guards (H-2)', () => {
  it('throws when allowedSshIps is omitted', () => {
    expect(() => buildHetznerComposeProgram(baseComposeConfig)).toThrow(/allowedSshIps required/);
  });

  it('throws when allowedSshIps is empty', () => {
    expect(() => buildHetznerComposeProgram({ ...baseComposeConfig, allowedSshIps: [] })).toThrow(
      /allowedSshIps required/,
    );
  });

  it('returns a program when allowedSshIps is populated', () => {
    const program = buildHetznerComposeProgram({
      ...baseComposeConfig,
      allowedSshIps: ['1.2.3.4/32'],
    });
    expect(typeof program).toBe('function');
  });
});
