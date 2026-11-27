/**
 * Census: every provider resource the CLI's Pulumi programs construct has a
 * probe in stack-probes.ts. A stack is deleted only when everything it
 * recorded reads 404, and a type with no probe reads unknown, so a new
 * resource type added to a program without a probe would keep every stack of
 * that provider forever (the stale-stack sweep would silently do nothing).
 * The walk reads the constructions in src/lib and resolves each class from
 * the installed SDK, so the check follows the code, not a list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vultr from '@ediri/vultr';
import * as digitalocean from '@pulumi/digitalocean';
import * as hcloud from '@pulumi/hcloud';
import * as linode from '@pulumi/linode';
import * as scaleway from '@pulumiverse/scaleway';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';
import { PROBED_TYPES } from '../../e2e/utils/stack-probes.ts';

/**
 * Every type the sweep has ever been able to confirm gone, per provider. A
 * probe once added is never removed: an older stack still records the types
 * its program made then, and a type with no probe reads unknown, which keeps
 * that stack and its S3 object forever (#601 dropped the Vultr ReservedIp
 * probe with the program's ReservedIp, and two civ4 k8s-ha stacks were kept
 * though Vultr answered 404 for both IPs; DigitalOcean's ReservedIp and
 * ReservedIpAssignment, dropped from the program in #418, had no probe at all).
 * Add a type here when a program starts making it. Never delete a line.
 */
const NEVER_DROP: Record<string, string[]> = {
  hetzner: [
    'hcloud:index/server:Server',
    'hcloud:index/firewall:Firewall',
    'hcloud:index/floatingIp:FloatingIp',
    'hcloud:index/network:Network',
    'hcloud:index/placementGroup:PlacementGroup',
    'hcloud:index/sshKey:SshKey',
    'hcloud:index/networkSubnet:NetworkSubnet',
    'hcloud:index/floatingIpAssignment:FloatingIpAssignment',
  ],
  digitalocean: [
    'digitalocean:index/droplet:Droplet',
    'digitalocean:index/firewall:Firewall',
    'digitalocean:index/sshKey:SshKey',
    'digitalocean:index/tag:Tag',
    'digitalocean:index/vpc:Vpc',
    'digitalocean:index/reservedIp:ReservedIp',
    'digitalocean:index/reservedIpAssignment:ReservedIpAssignment',
  ],
  linode: [
    'linode:index/firewall:Firewall',
    'linode:index/instance:Instance',
    'linode:index/sshKey:SshKey',
    'linode:index/vpc:Vpc',
    'linode:index/reservedIp:ReservedIp',
    'linode:index/vpcSubnet:VpcSubnet',
  ],
  vultr: [
    'vultr:index/instance:Instance',
    'vultr:index/firewallGroup:FirewallGroup',
    'vultr:index/sSHKey:SSHKey',
    'vultr:index/firewallRule:FirewallRule',
    'vultr:index/vpc:Vpc',
    'vultr:index/reservedIp:ReservedIp',
  ],
  scaleway: [
    'scaleway:instance/server:Server',
    'scaleway:instance/ip:Ip',
    'scaleway:instance/securityGroup:SecurityGroup',
    'scaleway:network/vpc:Vpc',
    'scaleway:network/privateNetwork:PrivateNetwork',
    'scaleway:iam/sshKey:SshKey',
  ],
};

const SDKS: Record<string, { provider: string; mod: unknown }> = {
  '@pulumi/hcloud': { provider: 'hetzner', mod: hcloud },
  '@pulumi/digitalocean': { provider: 'digitalocean', mod: digitalocean },
  '@pulumi/linode': { provider: 'linode', mod: linode },
  '@ediri/vultr': { provider: 'vultr', mod: vultr },
  '@pulumiverse/scaleway': { provider: 'scaleway', mod: scaleway },
};

interface Construction {
  file: string;
  provider: string;
  path: string;
  type: string;
}

const badImports: string[] = [];

function constructions(): Construction[] {
  const out: Construction[] = [];
  for (const file of sourceFiles(join(REPO_ROOT, 'src', 'lib'), { exts: ['.js'] })) {
    const src = readFileSync(file, 'utf8');
    // import * as <ns> from '<pkg>'
    const ns: Record<string, string> = {};
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (
        SDKS[m[1]] &&
        !new RegExp(`^\\s*import \\* as \\w+ from ['"]${m[1]}['"]`, 'm').test(m[0])
      ) {
        badImports.push(`${file}: ${m[0].trim()}`);
      }
    }
    for (const m of src.matchAll(/import \* as (\w+) from ['"]([^'"]+)['"]/g)) {
      if (SDKS[m[2]]) ns[m[1]] = m[2];
    }
    for (const m of src.matchAll(/new (\w+)\.([A-Za-z.]+)\(/g)) {
      const pkg = ns[m[1]];
      if (!pkg) continue;
      let cls: unknown = SDKS[pkg].mod;
      for (const part of m[2].split('.'))
        cls = (cls as Record<string, unknown> | undefined)?.[part];
      const type = (cls as { __pulumiType?: string } | undefined)?.__pulumiType;
      out.push({ file, provider: SDKS[pkg].provider, path: m[2], type: type ?? '' });
    }
  }
  return out;
}

const found = constructions();

describe('stack probe census', () => {
  it('every SDK import is `import * as X from <pkg>`, the one form the walk reads', () => {
    expect(
      badImports,
      `these files import a provider SDK in a form the census cannot follow (a named or default import hides its constructions); use import * as X: ${badImports.join('; ')}`,
    ).toEqual([]);
  });

  it('finds the constructions (guards against an empty walk)', () => {
    expect(found.map((c) => c.type)).toContain('hcloud:index/server:Server');
    expect(new Set(found.map((c) => c.provider)).size).toBe(5);
  });

  it.each(found.map((c) => [`${c.provider} ${c.path}`, c] as const))(
    '%s resolves to a class and has a probe',
    (_name, c) => {
      expect(c.type, `${c.path} did not resolve from the ${c.provider} SDK`).not.toBe('');
      expect(PROBED_TYPES[c.provider]).toContain(c.type);
    },
  );

  it.each(Object.entries(NEVER_DROP))(
    '%s keeps a probe for every type it ever had',
    (provider, types) => {
      const missing = types.filter((t) => !PROBED_TYPES[provider]?.includes(t));
      expect(
        missing,
        `${provider} lost the probe for ${missing.join(', ')}. Older stacks still record these types, and a type with no probe keeps its stack forever (#601). Put the probe back; never remove one.`,
      ).toEqual([]);
    },
  );

  it('the frozen list names every provider and every probed type', () => {
    expect(Object.keys(NEVER_DROP).sort()).toEqual(Object.keys(PROBED_TYPES).sort());
    for (const [provider, types] of Object.entries(PROBED_TYPES)) {
      expect(
        types.filter((t) => !NEVER_DROP[provider].includes(t)),
        `${provider} has a probe the frozen list does not name; add it to NEVER_DROP`,
      ).toEqual([]);
    }
  });
});
