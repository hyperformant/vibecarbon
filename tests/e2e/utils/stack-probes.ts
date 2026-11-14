/**
 * Per-provider "is this recorded resource gone?" probes for the stale-stack
 * sweep (sweep-run-stacks.ts). One GET by id: 404 is gone, 2xx is present,
 * anything else (401, 429, 5xx, a thrown error) and any type without a probe
 * is unknown, which keeps the stack. A wrong "gone" would delete the only
 * record of a live resource; a wrong "unknown" costs one S3 object.
 *
 * Type tokens come from the SDK classes (`Class.__pulumiType`), never from
 * hand-typed strings, and stack-probes-census.test.ts walks src/lib so a new
 * resource type in a program cannot ship without a probe here.
 *
 * Id formats (the provider packages document each import id; the state id is
 * the same value):
 * - hcloud NetworkSubnet: "<network id>-<ip range>", so the network is probed.
 *   FloatingIpAssignment: the floating IP id. All others: the numeric id.
 * - digitalocean Tag: the tag name. Others: the API id.
 * - linode ReservedIp: the address. VpcSubnet: the subnet id, with the vpc
 *   read from outputs/inputs (an import id "<vpc>,<subnet>" is accepted too).
 * - vultr FirewallRule: the numeric rule id, the group from inputs/outputs
 *   (or an import id "<group>,<rule>"); a gone group means a gone rule.
 * - scaleway instance resources: "<zone>/<uuid>"; iam SshKey: a bare uuid.
 *
 * The token comes from the caller; this module never reads an env file.
 */

import * as vultr from '@ediri/vultr';
import * as digitalocean from '@pulumi/digitalocean';
import * as hcloud from '@pulumi/hcloud';
import * as linode from '@pulumi/linode';
import * as scaleway from '@pulumiverse/scaleway';
import type { ProbeResult, RecordedResource, ResourceProbe } from './sweep-run-stacks.ts';

type Status = number | 'error';
type Get = (url: string) => Promise<Status>;
/** A probe for one resource type; `get` is already authenticated. */
type TypeProbe = (r: RecordedResource, get: Get) => Promise<ProbeResult>;

/** The SDK declares `__pulumiType` on every resource class in its .js, not its .d.ts. */
const typeOf = (cls: unknown): string => (cls as { __pulumiType: string }).__pulumiType;

const enc = encodeURIComponent;

const fromStatus = (s: Status): ProbeResult =>
  s === 404 ? 'gone' : typeof s === 'number' && s >= 200 && s < 300 ? 'present' : 'unknown';

/** Probe a single URL built from the resource; null from `url` means unknown. */
const byUrl =
  (url: (r: RecordedResource) => string | null): TypeProbe =>
  async (r, get) => {
    const u = url(r);
    return u === null ? 'unknown' : fromStatus(await get(u));
  };

/** A plain collection: `<base>/<path>/<id>`. */
const plain = (base: string, path: string) => byUrl((r) => `${base}/${path}/${enc(r.id)}`);

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null;
const field = (r: RecordedResource, key: string) => str(r.outputs?.[key]) ?? str(r.inputs?.[key]);

const HCLOUD = 'https://api.hetzner.cloud/v1';
const DO = 'https://api.digitalocean.com/v2';
const LINODE = 'https://api.linode.com/v4';
const VULTR = 'https://api.vultr.com/v2';
const SCW = 'https://api.scaleway.com';

/** Scaleway "<zone>/<uuid>" ids: the zoned endpoint, unknown without a zone. */
const zoned = (path: string) =>
  byUrl((r) => {
    const [zone, uuid, ...rest] = r.id.split('/');
    return zone && uuid && rest.length === 0
      ? `${SCW}/instance/v1/zones/${enc(zone)}/${path}/${enc(uuid)}`
      : null;
  });

const vultrRule: TypeProbe = async (r, get) => {
  let group = field(r, 'firewallGroupId');
  let rule = r.id;
  const comma = r.id.indexOf(',');
  if (comma !== -1) {
    group = r.id.slice(0, comma);
    rule = r.id.slice(comma + 1);
  }
  if (!group) return 'unknown';
  if ((await get(`${VULTR}/firewalls/${enc(group)}`)) === 404) return 'gone';
  return fromStatus(await get(`${VULTR}/firewalls/${enc(group)}/rules/${enc(rule)}`));
};

const PROBES: Record<string, Record<string, TypeProbe>> = {
  hetzner: {
    [typeOf(hcloud.Server)]: plain(HCLOUD, 'servers'),
    [typeOf(hcloud.Firewall)]: plain(HCLOUD, 'firewalls'),
    [typeOf(hcloud.FloatingIp)]: plain(HCLOUD, 'floating_ips'),
    [typeOf(hcloud.Network)]: plain(HCLOUD, 'networks'),
    [typeOf(hcloud.PlacementGroup)]: plain(HCLOUD, 'placement_groups'),
    [typeOf(hcloud.SshKey)]: plain(HCLOUD, 'ssh_keys'),
    // The subnet has no endpoint of its own; it lives and dies with its network.
    [typeOf(hcloud.NetworkSubnet)]: byUrl((r) => {
      const network = r.id.split('-')[0];
      return /^\d+$/.test(network) ? `${HCLOUD}/networks/${network}` : null;
    }),
    // The assignment is an attribute of the floating IP, whose id it carries.
    [typeOf(hcloud.FloatingIpAssignment)]: plain(HCLOUD, 'floating_ips'),
  },
  digitalocean: {
    [typeOf(digitalocean.Droplet)]: plain(DO, 'droplets'),
    [typeOf(digitalocean.Firewall)]: plain(DO, 'firewalls'),
    [typeOf(digitalocean.SshKey)]: plain(DO, 'account/keys'),
    [typeOf(digitalocean.Tag)]: plain(DO, 'tags'),
    [typeOf(digitalocean.Vpc)]: plain(DO, 'vpcs'),
  },
  linode: {
    [typeOf(linode.Firewall)]: plain(LINODE, 'networking/firewalls'),
    [typeOf(linode.Instance)]: plain(LINODE, 'linode/instances'),
    [typeOf(linode.SshKey)]: plain(LINODE, 'profile/sshkeys'),
    [typeOf(linode.Vpc)]: plain(LINODE, 'vpcs'),
    [typeOf(linode.ReservedIp)]: plain(LINODE, 'networking/reserved/ips'),
    [typeOf(linode.VpcSubnet)]: byUrl((r) => {
      let vpc = field(r, 'vpcId');
      let subnet = r.id;
      const comma = r.id.indexOf(',');
      if (comma !== -1) {
        vpc = r.id.slice(0, comma);
        subnet = r.id.slice(comma + 1);
      }
      return vpc ? `${LINODE}/vpcs/${enc(vpc)}/subnets/${enc(subnet)}` : null;
    }),
  },
  vultr: {
    [typeOf(vultr.Instance)]: plain(VULTR, 'instances'),
    [typeOf(vultr.FirewallGroup)]: plain(VULTR, 'firewalls'),
    [typeOf(vultr.SSHKey)]: plain(VULTR, 'ssh-keys'),
    [typeOf(vultr.FirewallRule)]: vultrRule,
  },
  scaleway: {
    [typeOf(scaleway.instance.Server)]: zoned('servers'),
    [typeOf(scaleway.instance.Ip)]: zoned('ips'),
    [typeOf(scaleway.instance.SecurityGroup)]: zoned('security_groups'),
    [typeOf(scaleway.iam.SshKey)]: plain(`${SCW}/iam/v1alpha1`, 'ssh-keys'),
  },
};

/** Provider id to the Pulumi type tokens it can probe. */
export const PROBED_TYPES: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(PROBES).map(([provider, types]) => [provider, Object.keys(types)]),
);

export function probeFor(
  provider: string,
  o: { token: string; env: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): ResourceProbe {
  const doFetch = o.fetchImpl ?? fetch;
  const headers: Record<string, string> =
    provider === 'scaleway' ? { 'X-Auth-Token': o.token } : { Authorization: `Bearer ${o.token}` };
  const get: Get = async (url) => {
    try {
      const res = await doFetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      return res.status;
    } catch {
      return 'error';
    }
  };
  const table = PROBES[provider] ?? {};
  return async (r) => {
    const probe = table[r.type];
    if (!probe) return 'unknown';
    try {
      return await probe(r, get);
    } catch {
      return 'unknown';
    }
  };
}
