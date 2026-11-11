/**
 * Where destroy looks for a floating or reserved IP by its labels.
 *
 * A deploy killed while the IP was being created leaves it named nowhere:
 * the pre-destroy refresh drops Pulumi's pending create, and the address
 * never reached .vibecarbon.json. The provider's programs label it with the
 * project and the stack's environment, so destroy asks
 * `deleteReservedIpsByLabels` for exactly those two labels:
 *   - k8s and k8s-ha: once per stack, on every provider that has the method,
 *     with or without the name sweeps (K8S_DESTROY_BACKSTOP);
 *   - compose: once, where the provider's compose program makes an IP
 *     (COMPOSE_FLOATING_IP), and never where it makes none.
 *
 * Each tier's real destroy effect runs against a fake provider that records
 * the calls (the same driving as dns-after-compute-census.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const labelCalls: Array<Record<string, string>> = [];
const holder: { Provider: unknown } = { Provider: null };

/** A provider whose every teardown call succeeds and finds nothing. */
function fakeProvider(statics: Record<string, unknown>, withSweep: boolean) {
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === 'constructor') return FakeProvider;
      if (prop === 'deleteReservedIpsByLabels') {
        if (!withSweep) return undefined;
        return async (labels: Record<string, string>) => {
          labelCalls.push(labels);
          return { deleted: [], failed: [] };
        };
      }
      if (/^(delete|remove|destroy|detach|release)/.test(prop)) {
        return async () => ({ deleted: false, everExisted: false, apiError: null, removed: true });
      }
      if (prop === 'listServersDetailed') return async () => ({ items: [], complete: true });
      if (/^(list|find|get)/.test(prop)) return async () => [];
      if (/^(serverNetworkIds|serverVolumeIds)$/.test(prop)) return () => [];
      return () => undefined;
    },
  };
  function FakeProvider() {
    return new Proxy({}, handler);
  }
  Object.assign(FakeProvider, { NAME: 'FakeCloud', ...statics });
  return FakeProvider;
}

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, providerFor: () => holder.Provider };
});

vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyK8s: async () => ({ destroyed: true, resourcesDeleted: 1, summary: { delete: 1 } }),
  };
});

import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

const spinner = { start: () => {}, stop: () => {}, message: () => {} };

function makeCtx(tier: string, stackEnvs: string[]) {
  return {
    plan: {
      tier,
      stackEnvs,
      hasPulumiStack: tier.startsWith('k8s'),
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
      ownedIps: [],
    },
    // No domain: DNS is out of this test.
    envConfig: { provider: 'hetzner', tier, servers: [], region: 'nbg1' },
    projectConfig: { projectName: 'proj' },
    environment: 'prod',
    providerToken: 'tok',
    results: {
      leaks: createLeakLedger(),
      servers: [] as string[],
      firewalls: [] as string[],
      sshKeys: [] as string[],
      dns: [] as string[],
      healthChecks: [] as string[],
      volumes: [] as string[],
      loadBalancers: [] as string[],
      unreleasedReservedIps: [] as string[],
    },
    spinner,
    tracker: { spinner: () => spinner },
    cwd: '/tmp/vibecarbon-label-backstop-nowhere',
  };
}

async function run(effect: string, ctx: ReturnType<typeof makeCtx>) {
  const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
  await (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>)[effect](
    ctx,
    {},
  );
}

beforeEach(() => {
  labelCalls.length = 0;
});

describe('k8s: every stack is asked by its own labels', () => {
  it.each([
    ['without the name sweeps (Hetzner)', { K8S_DESTROY_BACKSTOP: undefined }],
    ['with them (Linode)', { K8S_DESTROY_BACKSTOP: true }],
  ])('%s', async (_, statics) => {
    holder.Provider = fakeProvider(statics, true);
    await run('destroyK8sInfra', makeCtx('k8s', ['prod']));
    expect(labelCalls).toEqual([{ project: 'proj', environment: 'prod' }]);

    labelCalls.length = 0;
    await run('destroyK8sInfra', makeCtx('k8s-ha', ['prod-primary', 'prod-standby']));
    expect(labelCalls).toEqual([
      { project: 'proj', environment: 'prod-primary' },
      { project: 'proj', environment: 'prod-standby' },
    ]);
  });

  it('a provider without the method is not asked (DigitalOcean: its reserved IPs carry no labels)', async () => {
    holder.Provider = fakeProvider({ K8S_DESTROY_BACKSTOP: true }, false);
    await run('destroyK8sInfra', makeCtx('k8s', ['prod']));
    expect(labelCalls).toEqual([]);
  });
});

describe('compose: asked only where the compose program makes an IP', () => {
  it('COMPOSE_FLOATING_IP (Scaleway): asked once, by the environment', async () => {
    holder.Provider = fakeProvider({ COMPOSE_FLOATING_IP: true }, true);
    await run('destroyComposeServices', makeCtx('compose', ['prod']));
    expect(labelCalls).toEqual([{ project: 'proj', environment: 'prod' }]);
  });

  it('no compose IP (Hetzner, Linode): never asked, even with the method', async () => {
    holder.Provider = fakeProvider({ COMPOSE_FLOATING_IP: false }, true);
    await run('destroyComposeServices', makeCtx('compose', ['prod']));
    expect(labelCalls).toEqual([]);
  });
});
