/**
 * What IPAM reports as a Scaleway server's private addresses, for the
 * censuses that run every k8s program under Pulumi's mock runtime.
 *
 * scaleway-k8s.js reads the master's and the database node's Private Network
 * address from `privateIps` and fails the program when none is an IPv4 inside
 * the cluster's subnet. A mock that reported none would fail Scaleway's
 * program before a census read anything, so each census's `newResource`
 * spreads this into the state it returns.
 *
 * Stateful, one per mock runtime: a Private Network's subnet is recorded
 * under the id the mock gave it, and a server attached to it
 * (`privateNetworks[].pnId`) gets what IPAM lists for its NIC, an address
 * from the network's IPv6 block first, then an IPv4 inside the subnet. Every
 * other resource gets nothing.
 */
import { ipv4ToInt } from '../../src/lib/cidr.js';

const PRIVATE_NETWORK = 'scaleway:network/privateNetwork:PrivateNetwork';
const SERVER = 'scaleway:instance/server:Server';

type MockArgs = { type: string; inputs: Record<string, unknown> };

const ipv4 = (n: number) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');

/**
 * @returns `(args, id)`: the extra state for the resource the mock is making,
 *   given the id it returns for it.
 */
export function scalewayPrivateIps(): (args: MockArgs, id: string) => Record<string, unknown> {
  const subnets = new Map<string, string>();
  let host = 0;
  return (args, id) => {
    if (args.type === PRIVATE_NETWORK) {
      const subnet = (args.inputs.ipv4Subnet as { subnet?: string } | undefined)?.subnet;
      if (subnet) subnets.set(id, subnet);
      return {};
    }
    if (args.type !== SERVER) return {};
    const networks = (args.inputs.privateNetworks ?? []) as { pnId?: string }[];
    host += 1;
    return {
      privateIps: networks.flatMap(({ pnId }) => {
        const subnet = pnId === undefined ? undefined : subnets.get(pnId);
        const base = subnet ? ipv4ToInt(subnet.split('/')[0]) : null;
        if (base === null) return [];
        return [
          { id: `ipam-v6-${host}`, address: `fd5c:1:2:3::${host.toString(16)}` },
          { id: `ipam-v4-${host}`, address: ipv4(base + 10 + (host % 200)) },
        ];
      }),
    };
  };
}
