/**
 * k8s-ha pilot-light standby and its add-ons (primary-only add-ons, Task 5).
 *
 * The pilot standby runs only its db. Every declared add-on is zeroed there
 * (primary-only ones write to the primary database; with-app-tier ones follow
 * the zeroed app tier), by `kubectl scale`, never a patch that would roll pods.
 * The zero lands straight after the app's own zero patch, so the window between
 * `apply -k` and the zero is the app's. The observability step only re-points
 * grafana-tls now; the scaling comes from the declaration.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  repointObservabilityCertOnStandby,
  zeroWorkloadsOnStandby,
} from '../../../src/lib/deploy/k8s/k3s.js';
import { k8sStandbyZeroedWorkloads } from '../../../src/lib/services/standby-policy.js';

const K3S_SRC = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');

/** A kubectl stand-in: the named objects exist, every call is recorded. */
function fakeKubectl(existing: string[]) {
  const calls: string[][] = [];
  const kubectl = async (argv: string[]) => {
    calls.push(argv);
    const at = argv.indexOf('get');
    if (at !== -1) {
      const name = argv[at + 2];
      return existing.includes(name) ? `${argv[at + 1]}.apps/${name}\n` : '';
    }
    return '';
  };
  return { calls, kubectl };
}

describe('zeroWorkloadsOnStandby', () => {
  it('scales only the workloads that exist, with kubectl scale', async () => {
    const { calls, kubectl } = fakeKubectl(['n8n']);
    const zeroed = await zeroWorkloadsOnStandby({
      env: {},
      workloads: k8sStandbyZeroedWorkloads(['n8n', 'metabase']),
      kubectl,
    });
    expect(zeroed).toEqual(['n8n']);
    const mutating = calls.filter((a) => !a.includes('get'));
    expect(mutating).toEqual([['-n', 'vibecarbon', 'scale', 'deployment', 'n8n', '--replicas=0']]);
    expect(calls).toContainEqual([
      '-n',
      'vibecarbon',
      'get',
      'deployment',
      'metabase',
      '--ignore-not-found',
      '-o',
      'name',
    ]);
    for (const a of calls) expect(a).not.toContain('patch');
  });

  it('zeroes the observability Deployments in their own namespace', async () => {
    const { calls, kubectl } = fakeKubectl(['grafana', 'prometheus', 'loki']);
    const zeroed = await zeroWorkloadsOnStandby({
      env: {},
      workloads: k8sStandbyZeroedWorkloads(['observability']),
      kubectl,
    });
    expect(zeroed).toEqual(['grafana', 'prometheus', 'loki']);
    expect(calls.filter((a) => a.includes('scale'))).toContainEqual([
      '-n',
      'vibecarbon-observability',
      'scale',
      'deployment',
      'grafana',
      '--replicas=0',
    ]);
  });

  it('an empty list returns [] and makes no call', async () => {
    const { calls, kubectl } = fakeKubectl([]);
    expect(await zeroWorkloadsOnStandby({ env: {}, workloads: [], kubectl })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('repointObservabilityCertOnStandby', () => {
  it('without the observability namespace it is a no-op', async () => {
    const { calls, kubectl } = fakeKubectl([]);
    expect(await repointObservabilityCertOnStandby({ env: {}, issuerName: 'le', kubectl })).toBe(
      false,
    );
    expect(calls.every((a) => a.includes('get'))).toBe(true);
  });

  it('re-points grafana-tls at the standby issuer and scales nothing', async () => {
    const { calls, kubectl } = fakeKubectl(['vibecarbon-observability', 'grafana-tls']);
    expect(await repointObservabilityCertOnStandby({ env: {}, issuerName: 'le', kubectl })).toBe(
      true,
    );
    expect(calls.some((a) => a.includes('scale'))).toBe(false);
    const patch = calls.find((a) => a.includes('patch')) as string[];
    expect(patch.slice(0, 5)).toEqual([
      '-n',
      'vibecarbon-observability',
      'patch',
      'certificate',
      'grafana-tls',
    ]);
  });
});

describe('applyK3sManifests pilot-standby block (source order)', () => {
  const body = K3S_SRC.slice(K3S_SRC.indexOf('export async function applyK3sManifests('));

  it('zeroes the declared add-ons straight after the app zero patch', () => {
    const appZero = body.indexOf("'applyK3sManifests: zero app deployment (pilot standby)'");
    const addonZero = body.indexOf('zeroWorkloadsOnStandby(');
    const reap = body.indexOf('Reap stale worker Node OBJECTS');
    expect(appZero).toBeGreaterThan(-1);
    expect(addonZero).toBeGreaterThan(appZero);
    expect(addonZero).toBeLessThan(reap);
    expect(body.slice(addonZero, reap)).toMatch(
      /k8sStandbyZeroedWorkloads\(enabledK8sAddonNames\(projectDir\)\)/,
    );
  });

  it('the observability branch only re-points the cert; nothing scales a whole namespace', () => {
    expect(body).toContain('await repointObservabilityCertOnStandby({ env, issuerName })');
    expect(K3S_SRC).not.toContain('demoteObservabilityOnStandby');
    expect(K3S_SRC).not.toMatch(/'scale',\s*'deployment',\s*'--all'/);
  });
});
