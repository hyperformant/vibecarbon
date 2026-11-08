/**
 * diagnose's network and egress sections read each provider's K8S_ASSETS.
 * Linode runs no cloud controller manager, so its `ccmSelector` and
 * `ccmDeployment` are empty. An empty selector made `kubectl get pods -l ''`
 * list every kube-system pod under a "Linode CCM logs" heading, and an empty
 * deployment made `kubectl get deploy ''` fail. A section whose asset is
 * empty is skipped, for every provider.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn((..._args: unknown[]) => '');
vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import { diagnoseK8s } from '../../../src/diagnose.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

type Call = { cmd: string; args: string[] };

function stubReport() {
  const subsections: string[] = [];
  return {
    subsections,
    section: () => {},
    subsection: (title: string) => subsections.push(title),
    command: () => {},
    output: () => {},
    warn: () => {},
  };
}

async function runSections(Provider: { K8S_ASSETS: Record<string, string> }, providerId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-diag-'));
  const kubeconfig = join(dir, 'kubeconfig');
  writeFileSync(kubeconfig, 'apiVersion: v1\n');
  const report = stubReport();
  await diagnoseK8s({
    report,
    cmdEnv: {},
    kubeconfig,
    sshKey: join(dir, 'no-such-key'),
    controlplaneIp: null,
    Provider,
    providerId,
    sectionsToRun: ['network', 'egress'],
  });
  const calls: Call[] = execFileSyncMock.mock.calls.map(([cmd, args]) => ({
    cmd: String(cmd),
    args: args as string[],
  }));
  return { calls, subsections: report.subsections };
}

const valueAfter = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const K8S_PROVIDERS = Object.entries(PROVIDERS).filter(([, P]) =>
  (P as { SUPPORTED_TIERS: string[] }).SUPPORTED_TIERS.includes('k8s'),
) as Array<[string, { NAME: string; K8S_ASSETS: Record<string, string> }]>;

beforeEach(() => {
  execFileSyncMock.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('diagnose skips a section whose provider asset is empty', () => {
  it('sees Linode among the k8s providers, with no CCM', () => {
    const linode = K8S_PROVIDERS.find(([id]) => id === 'linode');
    expect(linode?.[1].K8S_ASSETS.ccmSelector).toBe('');
    expect(linode?.[1].K8S_ASSETS.ccmDeployment).toBe('');
  });

  it.each(K8S_PROVIDERS)('%s: never runs kubectl with an empty selector or name', async (id, P) => {
    const { calls } = await runSections(P, id);
    expect(calls.length).toBeGreaterThan(0);
    for (const { cmd, args } of calls) {
      if (cmd !== 'kubectl') continue;
      const sel = valueAfter(args, '-l');
      if (sel !== undefined) expect(sel, args.join(' ')).not.toBe('');
      const deploy = valueAfter(args, 'deploy');
      if (deploy !== undefined) expect(deploy, args.join(' ')).not.toBe('');
    }
  });

  it('Linode: no CCM log or env section', async () => {
    const [id, P] = K8S_PROVIDERS.find(([pid]) => pid === 'linode') as (typeof K8S_PROVIDERS)[0];
    const { subsections } = await runSections(P, id);
    expect(subsections.some((s) => /CCM/.test(s))).toBe(false);
    expect(subsections).toContain('Linode CSI controller logs');
  });

  it('Hetzner keeps its CCM log and env sections', async () => {
    const [id, P] = K8S_PROVIDERS.find(([pid]) => pid === 'hetzner') as (typeof K8S_PROVIDERS)[0];
    const { calls, subsections } = await runSections(P, id);
    expect(subsections).toContain('hcloud-CCM logs');
    expect(subsections.some((s) => s.startsWith('CCM env vars'))).toBe(true);
    expect(
      calls.some(({ args }) => valueAfter(args, 'deploy') === P.K8S_ASSETS.ccmDeployment),
    ).toBe(true);
  });
});
