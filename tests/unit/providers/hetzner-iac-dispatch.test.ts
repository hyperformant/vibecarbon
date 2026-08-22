/**
 * IaC program dispatch statics (CD2) — HetznerProvider.getComposeProgram /
 * getK8sProgram, the single seam Phase B (DigitalOcean) will slot into
 * instead of editing the seven shared engine files that used to import
 * `buildHetzner*Program` by name.
 *
 * This file covers dispatch IDENTITY only: the statics must dynamic-import
 * the real program module and forward `config` to the builder verbatim,
 * returning exactly what the builder returns (the Pulumi Automation-API
 * program closure). The program module itself is mocked here — proving
 * laziness (no top-level @pulumi/* in the provider graph) is a SEPARATE
 * concern, covered by iac-dispatch-laziness.test.ts, since mocking the
 * program module here would hide a real @pulumi/* import if one leaked in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildComposeMock = vi.fn();
const buildK8sMock = vi.fn();

vi.mock('../../../src/lib/iac/programs/hetzner-compose.js', () => ({
  buildHetznerComposeProgram: (...args: unknown[]) => buildComposeMock(...args),
}));
vi.mock('../../../src/lib/iac/programs/hetzner-k8s.js', () => ({
  buildHetznerK8sProgram: (...args: unknown[]) => buildK8sMock(...args),
  networkZoneFor: (location: string) => location,
}));

import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

describe('HetznerProvider.getComposeProgram (CD2)', () => {
  beforeEach(() => {
    buildComposeMock.mockReset();
  });

  it('forwards config verbatim to buildHetznerComposeProgram', async () => {
    const config = { projectName: 'proj', environment: 'prod', location: 'fsn1' };
    const sentinelProgram = async () => ({ serverIp: '1.2.3.4' });
    buildComposeMock.mockReturnValue(sentinelProgram);

    await HetznerProvider.getComposeProgram(config);

    expect(buildComposeMock).toHaveBeenCalledTimes(1);
    expect(buildComposeMock).toHaveBeenCalledWith(config);
    // Same config object identity — no defaulting/cloning/mutation in the static.
    expect(buildComposeMock.mock.calls[0][0]).toBe(config);
  });

  it('returns exactly the builder-produced program closure (byte-identical forwarding)', async () => {
    const sentinelProgram = async () => ({ serverIp: '9.9.9.9' });
    buildComposeMock.mockReturnValue(sentinelProgram);

    const result = await HetznerProvider.getComposeProgram({ any: 'config' });

    expect(result).toBe(sentinelProgram);
  });

  it('propagates a builder throw (e.g. missing allowedSshIps) without wrapping it', async () => {
    buildComposeMock.mockImplementation(() => {
      throw new Error('allowedSshIps required');
    });

    await expect(HetznerProvider.getComposeProgram({})).rejects.toThrow('allowedSshIps required');
  });
});

describe('HetznerProvider.getK8sProgram (CD2)', () => {
  beforeEach(() => {
    buildK8sMock.mockReset();
  });

  it('forwards config verbatim to buildHetznerK8sProgram', async () => {
    const config = { projectName: 'proj', environment: 'prod', location: 'nbg1' };
    const sentinelProgram = async () => ({ masterIp: '5.6.7.8' });
    buildK8sMock.mockReturnValue(sentinelProgram);

    await HetznerProvider.getK8sProgram(config);

    expect(buildK8sMock).toHaveBeenCalledTimes(1);
    expect(buildK8sMock).toHaveBeenCalledWith(config);
    expect(buildK8sMock.mock.calls[0][0]).toBe(config);
  });

  it('returns exactly the builder-produced program closure (byte-identical forwarding)', async () => {
    const sentinelProgram = async () => ({ masterIp: '10.10.10.10' });
    buildK8sMock.mockReturnValue(sentinelProgram);

    const result = await HetznerProvider.getK8sProgram({ any: 'config' });

    expect(result).toBe(sentinelProgram);
  });

  it('propagates a builder throw (e.g. missing allowedK8sApiIps) without wrapping it', async () => {
    buildK8sMock.mockImplementation(() => {
      throw new Error('allowedK8sApiIps required');
    });

    await expect(HetznerProvider.getK8sProgram({})).rejects.toThrow('allowedK8sApiIps required');
  });
});
