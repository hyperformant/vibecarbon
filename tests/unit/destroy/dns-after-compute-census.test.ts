import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rule: never delete a DNS record while anything that could still validate or
 * serve it is alive. Every tier tears compute down first and DNS last.
 * (2026-11-04: a k8s-ha teardown deleted DNS while the cluster's cert-manager
 * was mid-validation; a lookup in that gap cached the name as NXDOMAIN for the
 * next deploy.)
 *
 * Behavioral census: each tier's destroy effect (DESTROY_EFFECTS) is driven
 * with the DNS provider, the compute provider and the Pulumi stack destroy
 * mocked into ONE ordered event log. Every mocked compute call awaits a tick,
 * so a Promise.all-style interleave of compute and DNS would put a dns:* event
 * before the last compute:* event and fail.
 */

const events: string[] = [];
const tick = () => new Promise<void>((r) => setTimeout(r, 2));

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (/^(delete|remove|destroy|detach|release)/.test(prop)) {
        return async () => {
          await tick();
          events.push(`compute:${prop}`);
          return { deleted: true, everExisted: true, apiError: null, removed: true };
        };
      }
      if (prop === 'listServersDetailed') return async () => ({ items: [], complete: true });
      if (/^(list|find|get)/.test(prop)) return async () => [];
      if (/^(serverNetworkIds|serverVolumeIds)$/.test(prop)) return () => [];
      return () => undefined;
    },
  };
  // A plain constructor function: `new` yields the returned Proxy.
  function FakeProvider() {
    return new Proxy({}, handler);
  }
  FakeProvider.NAME = 'Hetzner';
  return { ...real, providerFor: () => FakeProvider };
});

vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getDnsProvider: async () => ({
      getZones: async () => [],
      deleteApexAndWildcard: async () => {
        events.push('dns:deleteApexAndWildcard');
        return { deletedAny: true, preservedTargets: [] };
      },
      deleteHealthCheck: async (_t: string, _z: string, name: string) => {
        events.push(`dns:deleteHealthCheck:${name}`);
        return true;
      },
    }),
  };
});

vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyK8s: async ({ environment }: { environment: string }) => {
      await tick();
      events.push(`compute:pulumi-destroy:${environment}`);
      return { destroyed: true, resourcesDeleted: 1, summary: { delete: 1 } };
    },
  };
});

import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

const spinner = { start: () => {}, stop: () => {}, message: () => {} };

function makeCtx(tier: string, stackEnvs: string[]) {
  const ha = tier.endsWith('-ha');
  const servers = ha
    ? [
        { name: 'primary', ip: '203.0.113.1', id: 11 },
        { name: 'standby', ip: '203.0.113.2', id: 12 },
      ]
    : [{ name: 'master', ip: '203.0.113.1', id: 11 }];
  return {
    plan: {
      tier,
      stackEnvs,
      hasPulumiStack: tier.startsWith('k8s'),
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
      ownedIps: servers.map((s) => s.ip),
    },
    envConfig: {
      provider: 'hetzner',
      tier,
      domain: 'app.example.test',
      dns: { provider: 'cloudflare', zoneId: 'zone1' },
      servers,
      region: 'nbg1',
    },
    projectConfig: { projectName: 'proj' },
    environment: 'e2e',
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
    },
    spinner,
    tracker: { spinner: () => spinner },
    cwd: '/tmp/vibecarbon-census-nowhere',
  };
}

const CASES: Array<[string, string, string[]]> = [
  ['compose', 'destroyComposeServices', ['e2e']],
  ['compose-ha', 'destroyComposeHa', ['e2e-primary', 'e2e-standby']],
  ['k8s', 'destroyK8sInfra', ['e2e']],
  ['k8s-ha', 'destroyK8sInfra', ['e2e-primary', 'e2e-standby']],
];

describe('teardown deletes DNS only after compute is gone', () => {
  beforeEach(() => {
    events.length = 0;
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token');
  });

  it.each(CASES)(
    '%s: no dns event precedes the last compute event',
    async (tier, effect, stackEnvs) => {
      const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
      const ctx = makeCtx(tier, stackEnvs);
      await (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>)[effect](
        ctx,
        {},
      );

      const firstDns = events.findIndex((e) => e.startsWith('dns:'));
      const lastCompute = events.map((e) => e.startsWith('compute:')).lastIndexOf(true);
      expect(firstDns, `no DNS deletion ran: ${events.join(', ')}`).toBeGreaterThan(-1);
      expect(lastCompute, `no compute deletion ran: ${events.join(', ')}`).toBeGreaterThan(-1);
      expect(firstDns, events.join(', ')).toBeGreaterThan(lastCompute);
      if (tier.startsWith('k8s')) {
        for (const env of stackEnvs) expect(events).toContain(`compute:pulumi-destroy:${env}`);
      }
    },
  );
});
