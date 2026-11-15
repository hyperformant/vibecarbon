/**
 * Destroy claims a load balancer or volume by name only when the name is
 * exactly this environment's.
 *
 * Destroy matched a volume as its own ("cluster-name", an identity match,
 * deleted once detached) when its name CONTAINED `<project>-<env>`, and a load
 * balancer when its name or its `kubernetes.io/cluster/…` label key contained
 * it, or when it was named `<project>-lb`. A substring is not an owner:
 * `app-prod` is inside `myapp-prod-…` (another project) and `app-prod2-…` /
 * `app-prod-eu-…` (another environment), and `<project>-lb` names every
 * environment of the project at once. Nothing vibecarbon creates is named
 * that way (CSI volumes are `pvc-…`, and no manifest has a LoadBalancer
 * Service), so those matches could only ever fire on somebody else's
 * resource. Same class as #449 (a role word inside a CSI volume name):
 * tests/unit/destroy/orphaned-volumes-foreign-name-match.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanupLoadBalancers, cleanupOrphanedVolumes } from '../../../src/destroy.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const NETWORK_ID = 7;

interface FakeLb {
  id: number;
  name: string;
  labels?: Record<string, string>;
  private_net?: Array<{ network_id: number }>;
}

/** Hetzner-shaped load balancers, the shape cleanupLoadBalancers reads. */
function lbProvider(projectName: string, envName: string, lbs: FakeLb[]) {
  const deleteLoadBalancer = vi.fn(async (_id: number) => true);
  const provider = {
    listNetworks: async () => [{ id: NETWORK_ID, name: `${projectName}-${envName}-network` }],
    listLoadBalancers: async () => lbs,
    deleteLoadBalancer,
  };
  return { provider, deleteLoadBalancer };
}

const volume = (id: number, label: string) => ({
  id,
  label,
  // Not one of the cluster's regions, and not a `pvc-…` name: only an
  // identity match can claim these.
  region: 'eu-central',
  linode_id: null,
  tags: [],
  created: '2026-11-15T05:48:28',
});

async function volumesClaimed(projectName: string, envName: string, labels: string[]) {
  const provider = new LinodeProvider('token');
  vi.spyOn(provider, 'listVolumesDetailed').mockResolvedValue({
    items: labels.map((l, i) => volume(100 + i, l)),
    complete: true,
  });
  const deleteVolume = vi.spyOn(provider, 'deleteVolume').mockResolvedValue(true);
  const { deleted } = await cleanupOrphanedVolumes(provider, projectName, envName, [], ['us-iad'], {
    detachWaitMs: 0,
    pollIntervalMs: 0,
    sleep: async () => {},
    report: () => {},
  });
  return { deleted, deleteVolume };
}

describe('destroy never claims a volume because its name contains the cluster name', () => {
  it("leaves another project's and another environment's named volumes alone", async () => {
    const { deleted, deleteVolume } = await volumesClaimed('app', 'prod', [
      'myapp-prod-data',
      'app-prod2-data',
      'app-prod-eu-data',
      'backup-app-prod',
      'app-prod',
    ]);
    expect(deleted).toEqual([]);
    expect(deleteVolume).not.toHaveBeenCalled();
  });
});

describe('destroy claims a load balancer only by exact ownership', () => {
  it('claims its own network, its exact cluster label and its exact name, nothing else', async () => {
    const { provider, deleteLoadBalancer } = lbProvider('app', 'prod', [
      { id: 1, name: 'myapp-prod-lb' },
      { id: 2, name: 'app-prod2-lb' },
      { id: 3, name: 'app-lb' },
      { id: 4, name: 'a1b2c3', labels: { 'kubernetes.io/cluster/app-prod2': 'owned' } },
      { id: 5, name: 'a9f0e1', labels: { 'kubernetes.io/cluster/myapp-prod': 'owned' } },
      { id: 6, name: 'a7d4c2', private_net: [{ network_id: NETWORK_ID }] },
      { id: 7, name: 'a3e8b1', labels: { 'kubernetes.io/cluster/app-prod': 'owned' } },
      { id: 8, name: 'app-prod-lb' },
      { id: 9, name: 'a5c6d7', private_net: [{ network_id: NETWORK_ID + 1 }] },
    ]);
    const { deleted, failed } = await cleanupLoadBalancers(provider, 'app', 'prod');
    expect(failed).toEqual([]);
    expect(deleted.sort()).toEqual(['a3e8b1', 'a7d4c2', 'app-prod-lb']);
    expect(deleteLoadBalancer.mock.calls.map(([id]) => id).sort()).toEqual([6, 7, 8]);
  });
});

/**
 * Every pair of environments, hyphenated names included. Each other
 * environment's resources, named by every convention the old matchers
 * accepted, must be claimed only where the full name is exactly ours (a
 * hyphen-joined name can still spell ours exactly: project `app-prod` env `eu`
 * and project `app` env `prod-eu` are the same string, which no name match can
 * tell apart).
 */
describe('name ownership across every pair of environments', () => {
  const projects = ['a', 'app', 'myapp', 'app-prod'];
  const envs = ['prod', 'prod2', 'prod-eu', 'eu', 'e1'];
  const pairs = projects.flatMap((p) => envs.map((e) => ({ p, e })));

  it('claims a load balancer only on an exact name or cluster label', async () => {
    for (const ours of pairs) {
      const cluster = `${ours.p}-${ours.e}`;
      let id = 0;
      const lbs: FakeLb[] = pairs.flatMap((other) => {
        const otherCluster = `${other.p}-${other.e}`;
        return [
          { id: ++id, name: `${otherCluster}-lb` },
          // The old project-wide spelling, one per environment of the project.
          { id: ++id, name: `${other.p}-lb` },
          {
            id: ++id,
            name: `ccm-${id}`,
            labels: { [`kubernetes.io/cluster/${otherCluster}`]: 'owned' },
          },
        ];
      });
      const exactlyOurs = lbs
        .filter(
          (lb) => lb.name === `${cluster}-lb` || lb.labels?.[`kubernetes.io/cluster/${cluster}`],
        )
        .map((lb) => lb.name);
      // The sample must hold the near-misses the old matchers took.
      expect(lbs.some((lb) => lb.name !== `${cluster}-lb` && lb.name.includes(cluster))).toBe(
        pairs.some((o) => `${o.p}-${o.e}` !== cluster && `${o.p}-${o.e}`.includes(cluster)),
      );
      const { provider } = lbProvider(ours.p, ours.e, lbs);
      const { deleted } = await cleanupLoadBalancers(provider, ours.p, ours.e);
      expect(deleted.sort(), cluster).toEqual(exactlyOurs.sort());
    }
  });

  it('claims no named volume of any environment', async () => {
    for (const ours of pairs) {
      const labels = pairs.flatMap(({ p, e }) => [`${p}-${e}`, `${p}-${e}-data`, `x-${p}-${e}`]);
      const { deleted } = await volumesClaimed(ours.p, ours.e, labels);
      expect(deleted, `${ours.p}-${ours.e}`).toEqual([]);
    }
  });
});
