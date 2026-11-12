/**
 * Every rerun a destroy's own lines name carries -purge exactly when that
 * destroy had it (retryDestroyCommand). A -purge destroy that keeps the entry
 * keeps its buckets for the rerun, and a plain rerun would move the entry
 * and leave them where no destroy reaches them.
 *
 * Each tier's real teardown effect runs against a fake provider whose
 * listings fail (the label sweep for reserved IPs, the server listing) or
 * whose server delete fails, and against a k8s Pulumi destroy that throws or
 * finds an empty stack. Every line those leave names its rerun, and each is
 * read here with and without -purge. The census
 * (retry-command-census.test.ts) holds the spelling; this holds the wiring
 * of `args` down to each helper.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const world: {
  Provider: unknown;
  pulumi: 'clean' | 'throws' | 'empty';
  orphan: boolean;
} = { Provider: null, pulumi: 'clean', orphan: false };

/** A provider whose listings fail, and whose every delete finds nothing. */
function fakeProvider(statics: Record<string, unknown>) {
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === 'constructor') return FakeProvider;
      if (prop === 'deleteReservedIpsByLabels') {
        return async () => {
          throw new Error('label listing timed out');
        };
      }
      if (prop === 'listServersDetailed') {
        return async () => {
          if (!world.orphan) throw new Error('server listing timed out');
          return {
            items: [
              {
                id: 7,
                name: 'proj-prod-worker-x',
                labels: { project: 'proj', environment: 'prod', 'managed-by': 'vibecarbon' },
              },
            ],
            complete: true,
          };
        };
      }
      if (prop === 'serverLabels')
        return (sv: { labels?: Record<string, string> }) => sv.labels ?? {};
      if (prop === 'labelValue') return (_k: string, v: string) => v;
      if (prop === 'serverRegion') return () => 'nbg1';
      if (prop === 'deleteServer') {
        return async () => {
          throw new Error('server is locked');
        };
      }
      if (/^(delete|remove|destroy|detach|release)/.test(prop)) {
        return async () => ({ deleted: false, everExisted: false, apiError: null, removed: true });
      }
      if (/^(list|find|get)/.test(prop)) return async () => [];
      if (/^(serverNetworkIds|serverVolumeIds)$/.test(prop)) return () => [];
      return () => undefined;
    },
  };
  function FakeProvider() {
    return new Proxy({}, handler);
  }
  Object.assign(FakeProvider, { NAME: 'FakeCloud', getPublicIP: () => null, ...statics });
  return FakeProvider;
}

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, providerFor: () => world.Provider };
});

vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyK8s: async () => {
      if (world.pulumi === 'throws') throw new Error('stack is locked');
      if (world.pulumi === 'empty') return { resourceCount: 0 };
      return { destroyed: true, resourcesDeleted: 1, summary: { delete: 1 } };
    },
  };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyComposeHA: async () => {
      throw new Error('ssh refused');
    },
  };
});

import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

const spinner = { start: () => {}, stop: () => {}, message: () => {} };

function makeCtx(tier: string, stackEnvs: string[], purge: boolean) {
  return {
    plan: {
      tier,
      stackEnvs,
      hasPulumiStack: tier.startsWith('k8s'),
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
      ownedIps: [],
    },
    // No domain: DNS is out of this test. A recorded ingress makes an empty
    // Pulumi stack suspicious (recordPulumiDestroyOutcome).
    envConfig: { provider: 'hetzner', tier, servers: [], region: 'nbg1', ingressIp: '203.0.113.5' },
    projectConfig: { projectName: 'proj' },
    environment: 'prod',
    args: purge ? { purgeBackups: true } : {},
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
    cwd: '/tmp/vibecarbon-retry-hints-nowhere',
  };
}

type Line = { resourceClass: string; resource: string; hint?: string };

async function run(effect: string, ctx: ReturnType<typeof makeCtx>): Promise<Line[]> {
  const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
  await (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>)[effect](
    ctx,
    {},
  );
  return ctx.results.leaks.entries as Line[];
}

/** Every rerun a line names, and the lines of `cls` that name one. */
function reruns(lines: Line[]) {
  return lines.flatMap((l) =>
    [...(l.hint ?? '').matchAll(/`(vibecarbon destroy[^`]*)`/g)].map((m) => m[1]),
  );
}
const naming = (lines: Line[], cls: string) =>
  lines.filter((l) => l.resourceClass === cls && /`vibecarbon destroy /.test(l.hint ?? ''));

beforeEach(() => {
  world.pulumi = 'clean';
  world.orphan = false;
});

describe.each([
  ['a -purge destroy', true, 'vibecarbon destroy prod -purge'],
  ['a plain destroy', false, 'vibecarbon destroy prod'],
])('%s names its own rerun', (_, purge, command) => {
  it('compose: the reserved IP label check and the server sweep', async () => {
    world.Provider = fakeProvider({ COMPOSE_FLOATING_IP: true });
    const lines = await run('destroyComposeServices', makeCtx('compose', ['prod'], purge));
    expect(naming(lines, 'reserved-ip')).toHaveLength(1);
    expect(naming(lines, 'server')).toHaveLength(1);
    expect(new Set(reruns(lines))).toEqual(new Set([command]));
  });

  it('compose-ha: a teardown that throws, each side’s label check and the server sweep', async () => {
    world.Provider = fakeProvider({ COMPOSE_FLOATING_IP: true });
    const lines = await run('destroyComposeHa', makeCtx('compose-ha', ['prod'], purge));
    expect(naming(lines, 'compose-ha teardown')).toHaveLength(1);
    expect(naming(lines, 'reserved-ip')).toHaveLength(2);
    expect(naming(lines, 'server')).toHaveLength(1);
    expect(new Set(reruns(lines))).toEqual(new Set([command]));
  });

  it('k8s: the backstop label check and a Pulumi destroy that throws', async () => {
    world.Provider = fakeProvider({});
    world.pulumi = 'throws';
    const lines = await run('destroyK8sInfra', makeCtx('k8s', ['prod'], purge));
    expect(naming(lines, 'reserved-ip')).toHaveLength(1);
    expect(naming(lines, 'pulumi-stack')).toHaveLength(1);
    expect(new Set(reruns(lines))).toEqual(new Set([command]));
  });

  it('k8s: a Pulumi destroy that finds an empty stack, and an orphaned server it cannot delete', async () => {
    world.Provider = fakeProvider({});
    world.pulumi = 'empty';
    world.orphan = true;
    const lines = await run('destroyK8sInfra', makeCtx('k8s', ['prod'], purge));
    expect(naming(lines, 'pulumi-stack')).toHaveLength(1);
    expect(
      lines.filter(
        (l) => l.resourceClass === 'server' && /orphaned-server sweep/.test(l.hint ?? ''),
      ),
    ).toHaveLength(1);
    expect(new Set(reruns(lines))).toEqual(new Set([command]));
  });
});
