import { describe, expect, it } from 'vitest';

/**
 * Task 7 — the seven destroy-sweep field accessors (serverNetworkIds,
 * serverLabels, serverVolumeIds, serverRegion, volumeAttachedServerIds,
 * volumeRegion, volumeLabels — serverRegion added in Task 7 fix round 1) are
 * the seam destroy.js's cleanup* policy functions and destroyK8sTier's
 * pre-scan/orphan-sweep read cloud shapes through instead of Hetzner-shaped
 * field literals (`server.private_net`, `server.labels`, `volume.server`,
 * `volume.location`, `server.datacenter.location.name`, ...). Pure field
 * readers — no network I/O — so these are plain fixture-in/value-out unit
 * tests, one describe per provider, proving each accessor returns the SAME
 * provider-neutral shape from that provider's real wire shape.
 */

import { DigitalOceanProvider, encodeLabels } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import {
  encodeLabels as encodeLinodeLabels,
  LinodeProvider,
} from '../../../src/lib/providers/linode.js';
import {
  encodeLabels as encodeScalewayLabels,
  ScalewayProvider,
} from '../../../src/lib/providers/scaleway.js';
import {
  encodeLabels as encodeVultrLabels,
  VultrProvider,
} from '../../../src/lib/providers/vultr.js';

const hetzner = new HetznerProvider('tok-hetzner');
const digitalocean = new DigitalOceanProvider('tok-do');
const linode = new LinodeProvider('tok-linode');
const vultr = new VultrProvider('tok-vultr');
const scaleway = new ScalewayProvider('tok-scaleway');

describe('HetznerProvider destroy-sweep field accessors', () => {
  it('serverNetworkIds reads private_net[].network_id', () => {
    const server = { private_net: [{ network_id: 42 }, { network_id: 43 }] };
    expect(hetzner.serverNetworkIds(server)).toEqual([42, 43]);
    expect(hetzner.serverNetworkIds({})).toEqual([]);
  });

  it('serverLabels reads labels verbatim', () => {
    const server = { labels: { role: 'worker', 'cluster-autoscaler/node': 'static' } };
    expect(hetzner.serverLabels(server)).toEqual({
      role: 'worker',
      'cluster-autoscaler/node': 'static',
    });
    expect(hetzner.serverLabels({})).toEqual({});
  });

  it('serverVolumeIds reads volumes verbatim', () => {
    expect(hetzner.serverVolumeIds({ volumes: [501, 502] })).toEqual([501, 502]);
    expect(hetzner.serverVolumeIds({})).toEqual([]);
  });

  it('serverRegion reads datacenter.location.name', () => {
    expect(hetzner.serverRegion({ datacenter: { location: { name: 'fsn1' } } })).toBe('fsn1');
    expect(hetzner.serverRegion({})).toBeNull();
  });

  it('volumeAttachedServerIds wraps the single `server` field (null -> [])', () => {
    expect(hetzner.volumeAttachedServerIds({ server: 900 })).toEqual([900]);
    expect(hetzner.volumeAttachedServerIds({ server: null })).toEqual([]);
  });

  it('volumeRegion reads location.name', () => {
    expect(hetzner.volumeRegion({ location: { name: 'fsn1' } })).toBe('fsn1');
    expect(hetzner.volumeRegion({})).toBeNull();
  });

  it('volumeLabels reads labels verbatim', () => {
    expect(hetzner.volumeLabels({ labels: { 'kubernetes.io/cluster': 'proj-prod' } })).toEqual({
      'kubernetes.io/cluster': 'proj-prod',
    });
    expect(hetzner.volumeLabels({})).toEqual({});
  });
});

describe('DigitalOceanProvider destroy-sweep field accessors', () => {
  it('serverNetworkIds wraps the single vpc_uuid field', () => {
    expect(digitalocean.serverNetworkIds({ vpc_uuid: 'vpc-abc' })).toEqual(['vpc-abc']);
    expect(digitalocean.serverNetworkIds({})).toEqual([]);
  });

  it('serverLabels decodes tags[] via the canonical encoding — round-trips encodeLabels', () => {
    const original = { role: 'worker', 'cluster-autoscaler/node': 'static', cluster: 'proj-prod' };
    const server = { tags: encodeLabels(original) };
    expect(digitalocean.serverLabels(server)).toEqual(original);
    expect(digitalocean.serverLabels({})).toEqual({});
  });

  it('serverVolumeIds reads volume_ids verbatim', () => {
    expect(digitalocean.serverVolumeIds({ volume_ids: ['vol-1', 'vol-2'] })).toEqual([
      'vol-1',
      'vol-2',
    ]);
    expect(digitalocean.serverVolumeIds({})).toEqual([]);
  });

  it('serverRegion reads region.slug (Task 7 fix round 1 — feeds destroyK8sTier.clusterLocations for DO)', () => {
    expect(digitalocean.serverRegion({ region: { slug: 'nyc3', name: 'New York 3' } })).toBe(
      'nyc3',
    );
    expect(digitalocean.serverRegion({})).toBeNull();
  });

  it('volumeAttachedServerIds reads droplet_ids verbatim (array, unlike Hetzner)', () => {
    expect(digitalocean.volumeAttachedServerIds({ droplet_ids: [700, 701] })).toEqual([700, 701]);
    expect(digitalocean.volumeAttachedServerIds({ droplet_ids: [] })).toEqual([]);
    expect(digitalocean.volumeAttachedServerIds({})).toEqual([]);
  });

  it('volumeRegion reads region.slug', () => {
    expect(digitalocean.volumeRegion({ region: { slug: 'nyc3', name: 'New York 3' } })).toBe(
      'nyc3',
    );
    expect(digitalocean.volumeRegion({})).toBeNull();
  });

  it('volumeLabels decodes tags[] via the canonical encoding — {} when the CSI driver set none', () => {
    // DO's CSI driver (csi-digitalocean v4.17.0, as shipped by
    // do-master-init.sh) tags no volumes it creates (no --do-tag /
    // --extra-create-metadata) — the realistic case is an empty tags array.
    expect(digitalocean.volumeLabels({ tags: [] })).toEqual({});
    expect(digitalocean.volumeLabels({})).toEqual({});
    // Still decodes correctly for any volume that DOES carry tags (e.g. one
    // tagged some other way) — same encoding as serverLabels.
    expect(digitalocean.volumeLabels({ tags: ['managed-by:vibecarbon'] })).toEqual({
      'managed-by': 'vibecarbon',
    });
  });
});

describe('LinodeProvider destroy-sweep field accessors', () => {
  it('serverNetworkIds is always [] — compose instances join no VPC, and the instance object carries no VPC field', () => {
    expect(linode.serverNetworkIds({ id: 1, region: 'us-iad' })).toEqual([]);
    expect(linode.serverNetworkIds({})).toEqual([]);
  });

  it('serverLabels decodes tags[] via the canonical encoding — round-trips encodeLabels', () => {
    const original = { role: 'compose', project: 'proj', environment: 'prod' };
    const server = { tags: encodeLinodeLabels(original) };
    expect(linode.serverLabels(server)).toEqual(original);
    expect(linode.serverLabels({})).toEqual({});
  });

  it('serverVolumeIds is always [] — Linode instances carry no volume ids; volume.linode_id is the authoritative direction', () => {
    // The sweep/destroy paths MUST cross-reference from the volume side
    // (volumeAttachedServerIds below) — this pin is the record of that
    // asymmetry, not a stub.
    expect(linode.serverVolumeIds({ id: 1 })).toEqual([]);
    expect(linode.serverVolumeIds({})).toEqual([]);
  });

  it('serverRegion reads the plain region slug string (not an object like DO)', () => {
    expect(linode.serverRegion({ region: 'us-iad' })).toBe('us-iad');
    expect(linode.serverRegion({})).toBeNull();
  });

  it('volumeAttachedServerIds wraps the single linode_id field (null -> [], like Hetzner)', () => {
    expect(linode.volumeAttachedServerIds({ linode_id: 900 })).toEqual([900]);
    expect(linode.volumeAttachedServerIds({ linode_id: null })).toEqual([]);
    expect(linode.volumeAttachedServerIds({})).toEqual([]);
  });

  it('volumeRegion reads the plain region slug string', () => {
    expect(linode.volumeRegion({ region: 'us-iad' })).toBe('us-iad');
    expect(linode.volumeRegion({})).toBeNull();
  });

  it('volumeLabels decodes tags[] via the canonical encoding', () => {
    expect(linode.volumeLabels({ tags: ['project:proj'] })).toEqual({ project: 'proj' });
    expect(linode.volumeLabels({ tags: [] })).toEqual({});
    expect(linode.volumeLabels({})).toEqual({});
  });

  it('volumeCreatedAt reads the ISO `created` field', () => {
    expect(linode.volumeCreatedAt({ created: '2026-08-07T00:00:00' })).toBe('2026-08-07T00:00:00');
    expect(linode.volumeCreatedAt({})).toBeNull();
  });
});

describe('VultrProvider destroy-sweep field accessors', () => {
  it('serverNetworkIds is always [] — compose instances join no VPC', () => {
    expect(vultr.serverNetworkIds({ id: 'uuid-1', region: 'ewr' })).toEqual([]);
    expect(vultr.serverNetworkIds({})).toEqual([]);
  });

  it('serverLabels decodes tags[] via the canonical encoding — round-trips encodeLabels', () => {
    const original = { role: 'compose', project: 'proj', environment: 'prod' };
    const server = { tags: encodeVultrLabels(original) };
    expect(vultr.serverLabels(server)).toEqual(original);
    expect(vultr.serverLabels({})).toEqual({});
  });

  it('serverVolumeIds is always [] — volume.attached_to_instance is the authoritative direction', () => {
    expect(vultr.serverVolumeIds({ id: 'uuid-1' })).toEqual([]);
    expect(vultr.serverVolumeIds({})).toEqual([]);
  });

  it('serverRegion reads the plain region-id string', () => {
    expect(vultr.serverRegion({ region: 'ewr' })).toBe('ewr');
    expect(vultr.serverRegion({})).toBeNull();
  });

  it('volumeAttachedServerIds wraps attached_to_instance (empty string when detached -> [])', () => {
    expect(vultr.volumeAttachedServerIds({ attached_to_instance: 'uuid-9' })).toEqual(['uuid-9']);
    expect(vultr.volumeAttachedServerIds({ attached_to_instance: '' })).toEqual([]);
    expect(vultr.volumeAttachedServerIds({})).toEqual([]);
  });

  it('volumeRegion reads the plain region-id string', () => {
    expect(vultr.volumeRegion({ region: 'ewr' })).toBe('ewr');
    expect(vultr.volumeRegion({})).toBeNull();
  });

  it('volumeLabels is {} — Vultr block volumes carry no tags, so name-prefix is the only owned signal', () => {
    // Deliberate pin of an asymmetry (see the accessor's doc): the sweep's
    // pvc-* tag-ownership rule can never match on Vultr.
    expect(vultr.volumeLabels({ id: 'uuid-1' })).toEqual({});
    expect(vultr.volumeLabels({})).toEqual({});
  });

  it('volumeCreatedAt reads the ISO `date_created` field', () => {
    expect(vultr.volumeCreatedAt({ date_created: '2026-08-08T00:00:00+00:00' })).toBe(
      '2026-08-08T00:00:00+00:00',
    );
    expect(vultr.volumeCreatedAt({})).toBeNull();
  });
});

describe('ScalewayProvider destroy-sweep field accessors', () => {
  it('serverNetworkIds is always [] — compose instances join no Private Network', () => {
    expect(scaleway.serverNetworkIds({ id: 'uuid-1', zone: 'fr-par-1' })).toEqual([]);
    expect(scaleway.serverNetworkIds({})).toEqual([]);
  });

  it('serverLabels decodes tags[] via the canonical encoding — round-trips encodeLabels', () => {
    const original = { role: 'compose', project: 'proj', environment: 'prod' };
    const server = { tags: encodeScalewayLabels(original) };
    expect(scaleway.serverLabels(server)).toEqual(original);
    expect(scaleway.serverLabels({})).toEqual({});
  });

  it("serverVolumeIds reads the server's volumes map (the terminate-detaches-SBS capture source)", () => {
    const server = {
      volumes: {
        '0': { id: 'vol-root', volume_type: 'sbs_volume' },
        '1': { id: 'vol-data', volume_type: 'sbs_volume' },
      },
    };
    expect(scaleway.serverVolumeIds(server)).toEqual(['vol-root', 'vol-data']);
    expect(scaleway.serverVolumeIds({})).toEqual([]);
  });

  it('serverRegion reads the zone string (Scaleway region == zone in our model)', () => {
    expect(scaleway.serverRegion({ zone: 'fr-par-1' })).toBe('fr-par-1');
    expect(scaleway.serverRegion({})).toBeNull();
  });

  it('volumeAttachedServerIds handles BOTH volume products: Instance-API server ref and Block-API references[]', () => {
    // Instance API (legacy volumes): `server: {id}` scalar.
    expect(scaleway.volumeAttachedServerIds({ server: { id: 'uuid-9' } })).toEqual(['uuid-9']);
    // Block Storage API (where every SBS root volume lives): references[]
    // keyed on product_resource_type — non-server references must not count.
    expect(
      scaleway.volumeAttachedServerIds({
        references: [
          { product_resource_type: 'instance_server', product_resource_id: 'uuid-7' },
          { product_resource_type: 'snapshot', product_resource_id: 'snap-1' },
        ],
      }),
    ).toEqual(['uuid-7']);
    expect(scaleway.volumeAttachedServerIds({ references: [] })).toEqual([]);
    expect(scaleway.volumeAttachedServerIds({})).toEqual([]);
  });

  it('volumeRegion reads the zone string', () => {
    expect(scaleway.volumeRegion({ zone: 'nl-ams-1' })).toBe('nl-ams-1');
    expect(scaleway.volumeRegion({})).toBeNull();
  });

  it('volumeLabels decodes tags[] — Scaleway volumes DO carry tags (unlike Vultr)', () => {
    const original = { project: 'proj' };
    expect(scaleway.volumeLabels({ tags: encodeScalewayLabels(original) })).toEqual(original);
    expect(scaleway.volumeLabels({})).toEqual({});
  });

  it('volumeCreatedAt reads creation_date (Instance API) or created_at (Block API)', () => {
    expect(scaleway.volumeCreatedAt({ creation_date: '2026-08-09T00:00:00Z' })).toBe(
      '2026-08-09T00:00:00Z',
    );
    expect(scaleway.volumeCreatedAt({ created_at: '2026-08-09T01:00:00Z' })).toBe(
      '2026-08-09T01:00:00Z',
    );
    expect(scaleway.volumeCreatedAt({})).toBeNull();
  });
});
