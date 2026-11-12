import { describe, expect, it, vi } from 'vitest';
import {
  cleanupOrphanedVolumes,
  foreignServerRegions,
  labelsNameEnvironment,
} from '../../../src/destroy.js';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { sweepEnvironmentServers } from '../../../src/lib/destroy/server-sweep.js';
import {
  DigitalOceanProvider,
  encodeLabels as doEncodeLabels,
} from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { encodeLabel, encodeLabels, LinodeProvider } from '../../../src/lib/providers/linode.js';

/**
 * Linode squeezes a tag past 50 characters (encodeLabel), so a project name
 * over 42 characters decodes to its squeezed value, not the raw name. Every
 * destroy ownership check compares the decoded label against
 * provider.labelValue(key, raw): ours still matches, and another project
 * whose squeezed prefix is the same still does not.
 */

// 47 characters each, identical for the first 45, so both squeeze to the
// same 33-character value prefix and differ only in the hash.
const LONG = 'acme-analytics-platform-production-workloads-eu';
const OTHER = 'acme-analytics-platform-production-workloads-us';

const linodeServer = (id: number, project: string, environment: string, region: string) => ({
  id,
  label: `${project.slice(0, 20)}-${id}`,
  region,
  tags: encodeLabels({ 'managed-by': 'vibecarbon', project, environment }),
});

describe('the squeezed project tag', () => {
  it('is squeezed, and the two projects share its value prefix', () => {
    const ours = encodeLabel('project', LONG);
    const theirs = encodeLabel('project', OTHER);
    expect(ours).toHaveLength(50);
    expect(ours).not.toBe(`project:${LONG}`);
    expect(ours.slice(0, 41)).toBe(theirs.slice(0, 41));
    expect(ours).not.toBe(theirs);
  });
});

describe('labelsNameEnvironment', () => {
  const linode = new LinodeProvider('t');
  const labelsOf = (project: string, environment: string) =>
    linode.serverLabels(linodeServer(1, project, environment, 'us-iad'));

  it('matches a Linode server whose project tag was squeezed', () => {
    expect(
      labelsNameEnvironment(linode, labelsOf(LONG, 'l4-primary'), LONG, [`${LONG}-l4-primary`]),
    ).toBe(true);
  });

  it("rejects another project's server with the same squeezed prefix", () => {
    expect(
      labelsNameEnvironment(linode, labelsOf(OTHER, 'l4-primary'), LONG, [`${LONG}-l4-primary`]),
    ).toBe(false);
  });

  it("rejects this project's server in another environment", () => {
    expect(
      labelsNameEnvironment(linode, labelsOf(LONG, 'l4-standby'), LONG, [`${LONG}-l4-primary`]),
    ).toBe(false);
  });

  it('matches raw long names on Hetzner and DigitalOcean, as before', () => {
    const hetzner = new HetznerProvider('t');
    const hLabels = hetzner.serverLabels({ labels: { project: LONG, environment: 'e1' } });
    expect(labelsNameEnvironment(hetzner, hLabels, LONG, [`${LONG}-e1`])).toBe(true);
    expect(labelsNameEnvironment(hetzner, hLabels, OTHER, [`${OTHER}-e1`])).toBe(false);

    const digitalocean = new DigitalOceanProvider('t');
    const dLabels = digitalocean.serverLabels({
      tags: doEncodeLabels({ project: LONG, environment: 'e1' }),
    });
    expect(dLabels.project).toBe(LONG);
    expect(labelsNameEnvironment(digitalocean, dLabels, LONG, [`${LONG}-e1`])).toBe(true);
    expect(labelsNameEnvironment(digitalocean, dLabels, OTHER, [`${OTHER}-e1`])).toBe(false);
  });
});

describe('foreignServerRegions on Linode with a squeezed project tag', () => {
  it("counts only the other project's region as foreign", () => {
    const linode = new LinodeProvider('t');
    const { regions, unreadable } = foreignServerRegions(
      linode,
      [
        linodeServer(1, LONG, 'l4-primary', 'us-iad'),
        linodeServer(2, OTHER, 'l4-primary', 'us-ord'),
      ],
      LONG,
      [`${LONG}-l4-primary`],
    );
    expect([...regions]).toEqual(['us-ord']);
    expect(unreadable).toBeNull();
  });
});

describe('sweepEnvironmentServers on Linode with a squeezed project tag', () => {
  it("deletes this environment's server and leaves the other project's", async () => {
    const linode = new LinodeProvider('t');
    vi.spyOn(linode, 'listServersDetailed').mockResolvedValue({
      items: [
        linodeServer(1, LONG, 'e2-primary', 'us-iad'),
        linodeServer(2, OTHER, 'e2-primary', 'us-iad'),
      ],
      complete: true,
    });
    const deleteServer = vi.spyOn(linode, 'deleteServer').mockResolvedValue(true);
    const leaks = createLeakLedger();

    await sweepEnvironmentServers({
      provider: linode,
      leaks,
      projectName: LONG,
      environment: 'e2',
      deployMode: 'compose-ha',
    });

    expect(deleteServer).toHaveBeenCalledExactlyOnceWith(1, {
      waitUntilGone: true,
      onLeftover: expect.any(Function),
    });
    expect(leaks.isClean()).toBe(true);
  });
});

describe('cleanupOrphanedVolumes on Linode with a squeezed project tag', () => {
  const volume = (id: number, label: string, project: string) => ({
    id,
    label,
    region: 'us-iad',
    linode_id: null,
    tags: [encodeLabel('project', project)],
    created: '2026-11-07T10:00:00',
  });

  it("deletes this project's detached pvc volume and keeps the other project's", async () => {
    const linode = new LinodeProvider('t');
    vi.spyOn(linode, 'listVolumesDetailed').mockResolvedValue({
      items: [volume(1, 'pvc-0123456789abcdef', OTHER), volume(2, 'pvc-fedcba9876543210', LONG)],
      complete: true,
    });
    const deleteVolume = vi.spyOn(linode, 'deleteVolume').mockResolvedValue(true);

    // No cluster regions, so only the project label can claim a volume.
    const { deleted } = await cleanupOrphanedVolumes(linode, LONG, 'prod', [], [], [], {
      report: () => {},
    });

    expect(deleteVolume).toHaveBeenCalledExactlyOnceWith(2);
    expect(deleted).toEqual(['pvc-fedcba9876543210']);
  });
});
