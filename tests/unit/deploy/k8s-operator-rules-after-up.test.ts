/**
 * Ruling RV5, one writer per firewall rule. On a provider whose k8s program
 * leaves the operator rules (SSH on 22, the Kubernetes API on 6443) to REST
 * (K8S_OPERATOR_RULES_AFTER_UP: Vultr), a fresh cluster's firewall has
 * neither after the up, so deployK3s writes them right after it and before
 * its first ssh (waitForK3sReady). writeOperatorRulesAfterUp
 * (lib/operator-ip.js) is that push: this file holds what it does, which
 * providers opt in, and where deployK3s calls it. deployK3s cannot be driven
 * in a unit test (it provisions a cluster), so the call site is pinned on
 * its source, as in k3s-build-overlaps-infra.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetry = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => ({
  ...((await orig()) as object),
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
}));

import { writeOperatorRulesAfterUp } from '../../../src/lib/operator-ip.js';
import { BaseProvider, PROVIDERS } from '../../../src/lib/providers/index.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { readRepoFile } from '../../_shared/source-files.js';
import { vultrFirewallApi } from '../../_shared/vultr-firewall-api.js';

type ProviderClass = typeof BaseProvider & { K8S_OPERATOR_RULES_AFTER_UP: boolean };
const classes = Object.entries(PROVIDERS) as [string, ProviderClass][];
const OPERATOR = [{ cidr: '203.0.113.5/32' }, { cidr: '2001:db8::1/128' }];

afterEach(() => {
  fetchWithRetry.mockReset();
  vi.restoreAllMocks();
});

describe('which providers write the operator rules after the up', () => {
  it('Vultr only: every other k8s program writes them itself', () => {
    expect(BaseProvider.K8S_OPERATOR_RULES_AFTER_UP).toBe(false);
    expect(
      classes
        .filter(([, P]) => P.K8S_OPERATOR_RULES_AFTER_UP)
        .map(([id]) => id)
        .sort(),
    ).toEqual(['vultr']);
  });

  it.each(classes.filter(([, P]) => !P.K8S_OPERATOR_RULES_AFTER_UP))(
    '%s: the push does nothing, and calls no API',
    async (_id, Provider) => {
      const find = vi.spyOn(Provider.prototype, 'findFirewallByName');
      const apply = vi.spyOn(Provider.prototype, 'applyOperatorCidrs');
      const set = vi.spyOn(Provider.prototype, 'setFirewallRules');
      expect(
        await writeOperatorRulesAfterUp({
          Provider,
          apiToken: 't',
          projectName: 'acme',
          stackName: 'prod',
          operatorCidrs: OPERATOR,
        }),
      ).toBe(false);
      expect(find).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(fetchWithRetry).not.toHaveBeenCalled();
    },
  );
});

describe('Vultr: the push after the up', () => {
  const HTTPS = { ip_type: 'v4', protocol: 'tcp', subnet: '0.0.0.0', subnet_size: 0, port: '443' };
  const VPC = { ip_type: 'v4', protocol: 'tcp', subnet: '10.181.32.0', subnet_size: 24 };

  function freshGroup(stackName: string) {
    const api = vultrFirewallApi({ groupId: 'gid-1', description: `acme-${stackName}-firewall` });
    api.create({ ...HTTPS, notes: 'https' });
    api.create({ ...VPC, port: '1:65535', notes: 'vpc-tcp' });
    api.calls.length = 0;
    fetchWithRetry.mockImplementation(api.fetch);
    return api;
  }

  it.each(['prod', 'prod-primary', 'prod-standby'])(
    '%s: makes 22 and 6443 for every address, and deletes nothing',
    async (stackName) => {
      const api = freshGroup(stackName);
      const before = new Map(api.rules);
      expect(
        await writeOperatorRulesAfterUp({
          Provider: VultrProvider,
          apiToken: 't',
          projectName: 'acme',
          stackName,
          operatorCidrs: OPERATOR,
        }),
      ).toBe(true);
      expect(api.calls.every((c) => c.method === 'POST')).toBe(true);
      expect(api.calls.map((c) => c.rule).sort()).toEqual(
        [
          'v4 tcp 203.0.113.5/32 22',
          'v6 tcp 2001:db8::1/128 22',
          'v4 tcp 203.0.113.5/32 6443',
          'v6 tcp 2001:db8::1/128 6443',
        ].sort(),
      );
      for (const [id, row] of before) expect(api.rules.get(id)).toEqual(row);
    },
  );

  it('run again (the next deploy that runs an up), it writes nothing', async () => {
    const api = freshGroup('prod');
    const args = {
      Provider: VultrProvider,
      apiToken: 't',
      projectName: 'acme',
      stackName: 'prod',
      operatorCidrs: OPERATOR,
    };
    await writeOperatorRulesAfterUp(args);
    api.calls.length = 0;
    await writeOperatorRulesAfterUp(args);
    expect(api.calls).toEqual([]);
  });

  it('refuses an empty list, which would let no operator in', async () => {
    freshGroup('prod');
    await expect(
      writeOperatorRulesAfterUp({
        Provider: VultrProvider,
        apiToken: 't',
        projectName: 'acme',
        stackName: 'prod',
        operatorCidrs: [],
      }),
    ).rejects.toThrow(/empty/);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('a firewall the provider does not list fails the deploy, naming it', async () => {
    freshGroup('prod');
    await expect(
      writeOperatorRulesAfterUp({
        Provider: VultrProvider,
        apiToken: 't',
        projectName: 'acme',
        stackName: 'staging',
        operatorCidrs: OPERATOR,
      }),
    ).rejects.toThrow(/acme-staging-firewall/);
  });
});

describe('deployK3s writes the operator rules after the up, before its first ssh', () => {
  const src = readRepoFile('src/lib/deploy/k8s/k3s.js');
  // deployK3s and the steps it runs, to the next export or the file's end.
  const start = src.indexOf('export async function deployK3s(');
  const next = src.indexOf('\nexport ', start + 1);
  const body = src.slice(start, next === -1 ? undefined : next);
  const call = body.indexOf('await writeOperatorRulesAfterUp({');

  it('is called once, inside the infra step, after its up and before the step completes', () => {
    expect(call).toBeGreaterThan(0);
    expect(body.indexOf('writeOperatorRulesAfterUp(', call + 'await '.length + 1)).toBe(-1);
    const gate = body.indexOf(
      "if (!infraStepSkips(state, 'k3s-infra', infraInputs, [options.environment])) {",
    );
    const up = body.indexOf('upStack(options.environment, program, {');
    const complete = body.indexOf("state.completeStep('k3s-infra', outputs);");
    expect(gate).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(gate);
    expect(call).toBeGreaterThan(up);
    expect(complete).toBeGreaterThan(call);
  });

  it('for this stack, with the list the program was given', () => {
    const args = body.slice(call, body.indexOf('});', call));
    expect(args).toMatch(/\bProvider,/);
    expect(args).toContain('apiToken: options.apiToken,');
    expect(args).toContain('projectName: options.projectName,');
    expect(args).toContain('stackName: options.environment,');
    expect(args).toContain('operatorCidrs: options.operatorCidrs ?? [],');
  });

  it('before anything in the deploy reaches a node', () => {
    const steps = body.slice(body.indexOf('async function deployK3sSteps('));
    const at = steps.indexOf('await writeOperatorRulesAfterUp({');
    // The first ssh is the wait for k3s, then the host-key scan.
    for (const reach of ['waitForK3sReady(', 'seedKnownHosts(']) {
      expect(steps.indexOf(reach), reach).toBeGreaterThan(at);
    }
    // Between the up's outputs check and the push, nothing else runs.
    const check = steps.indexOf('const missing = requiredOutputs.filter(');
    expect(check).toBeGreaterThan(0);
    expect(steps.slice(check, at)).not.toContain('await ');
  });
});
