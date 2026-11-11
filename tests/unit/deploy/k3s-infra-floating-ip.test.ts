/**
 * A DigitalOcean k8s cluster made before 2026-11 saved a `k3s-infra` result
 * naming its reserved IP as `floatingIp`. A deploy whose infra inputs did not
 * change skips the step and reads that result back; taken as is, the reserved
 * IP would be the cluster's ingress again (clusterIngressIp prefers it) and
 * the domain would stay on the address the deploy is about to release. So
 * deployK3s takes its floating IP only through infraFloatingIp, which names
 * none on a provider whose clusters have none, and no longer re-runs the step
 * to refresh that result: the stack's reserved IP leaves state by surgery
 * (lib/iac/retired-resources.js), never by an up that deletes it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clusterIngressIp, infraFloatingIp } from '../../../src/lib/deploy/k8s/ingress-ip.js';
// @ts-expect-error — JS module without types
import { StateTracker } from '../../../src/lib/deploy/state.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const SAVED = { masterIp: '198.51.100.7', floatingIp: '203.0.113.9' };

describe('infraFloatingIp', () => {
  it("DigitalOcean: a saved reserved IP is not the cluster's, so the master is the ingress", () => {
    expect(infraFloatingIp(SAVED, DigitalOceanProvider)).toBeUndefined();
    const result = {
      masterIp: SAVED.masterIp,
      floatingIp: infraFloatingIp(SAVED, DigitalOceanProvider),
    };
    expect(clusterIngressIp(result)).toBe('198.51.100.7');
  });

  it('Hetzner and Linode: the floating IP is the live ingress', () => {
    expect(infraFloatingIp(SAVED, HetznerProvider)).toBe('203.0.113.9');
    expect(infraFloatingIp(SAVED, LinodeProvider)).toBe('203.0.113.9');
  });

  it('a result without one names none', () => {
    expect(infraFloatingIp({ masterIp: '198.51.100.7' }, HetznerProvider)).toBeUndefined();
    expect(infraFloatingIp(null, HetznerProvider)).toBeUndefined();
  });
});

describe('a saved DigitalOcean result no longer forces the cluster up', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-k3s-infra-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unchanged inputs skip the step even with a reserved IP in the saved result', () => {
    const inputs = { region: 'nyc3', masterType: 's-2vcpu-4gb' };
    const state = new StateTracker('quorum', 'prod');
    state.startStep('k3s-infra', inputs);
    state.completeStep('k3s-infra', SAVED);
    expect(state.shouldSkip('k3s-infra', inputs)).toBe(true);
  });
});

describe('deployK3s reads its floating IP only through infraFloatingIp', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../src/lib/deploy/k8s/k3s.js', import.meta.url)),
    'utf8',
  );
  // The code that runs: from the infra step's gate to the function's return.
  const start = src.indexOf("if (!state.shouldSkip('k3s-infra', infraInputs)) {");
  const body = src.slice(start, src.indexOf('\nexport ', start));

  it('the infra step is gated on its inputs alone', () => {
    expect(start).toBeGreaterThan(0);
    expect(src).not.toContain('k3sInfraMustRun');
  });

  it('the saved result is read once, and its floatingIp only through the helper', () => {
    expect(body).toContain('const floatingIp = infraFloatingIp(infraOutputs, Provider);');
    // Never destructured straight off the result, never read off it elsewhere.
    const destructure = body.slice(
      body.indexOf("const infraOutputs = state.getStepResult('k3s-infra');"),
      body.indexOf('} = infraOutputs;'),
    );
    expect(destructure).not.toMatch(/\bfloatingIp\b/);
    expect(body).not.toMatch(/infraOutputs(\?)?\.floatingIp/);
  });
});
