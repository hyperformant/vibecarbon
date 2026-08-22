/**
 * M3 Task 5 — DigitalOceanProvider.getK8sProgram dispatch (CD2), mirroring
 * hetzner-iac-dispatch.test.ts's k8s section. Covers dispatch IDENTITY
 * only: the static must dynamic-import the real program module
 * (digitalocean-k8s.js) and forward `config` to the builder verbatim,
 * returning exactly what the builder returns. The program module itself is
 * mocked here — laziness (no top-level @pulumi/* in the provider graph) is
 * a separate concern, covered by iac-dispatch-laziness.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildK8sMock = vi.fn();

vi.mock('../../../src/lib/iac/programs/digitalocean-k8s.js', () => ({
  buildDigitalOceanK8sProgram: (...args: unknown[]) => buildK8sMock(...args),
}));

import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';

describe('DigitalOceanProvider.getK8sProgram (CD2)', () => {
  beforeEach(() => {
    buildK8sMock.mockReset();
  });

  it('forwards config verbatim to buildDigitalOceanK8sProgram', async () => {
    const config = { projectName: 'proj', environment: 'prod', location: 'nyc3' };
    const sentinelProgram = async () => ({ masterIp: '5.6.7.8' });
    buildK8sMock.mockReturnValue(sentinelProgram);

    await DigitalOceanProvider.getK8sProgram(config);

    expect(buildK8sMock).toHaveBeenCalledTimes(1);
    expect(buildK8sMock).toHaveBeenCalledWith(config);
    // Same config object identity — no defaulting/cloning/mutation in the static.
    expect(buildK8sMock.mock.calls[0][0]).toBe(config);
  });

  it('returns exactly the builder-produced program closure (byte-identical forwarding)', async () => {
    const sentinelProgram = async () => ({ masterIp: '10.10.10.10' });
    buildK8sMock.mockReturnValue(sentinelProgram);

    const result = await DigitalOceanProvider.getK8sProgram({ any: 'config' });

    expect(result).toBe(sentinelProgram);
  });

  it('propagates a builder throw (e.g. missing allowedK8sApiIps) without wrapping it', async () => {
    buildK8sMock.mockImplementation(() => {
      throw new Error('allowedK8sApiIps required');
    });

    await expect(DigitalOceanProvider.getK8sProgram({})).rejects.toThrow(
      'allowedK8sApiIps required',
    );
  });
});
