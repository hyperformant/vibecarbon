import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The database has no public port. Operators reach it through
 * `vibecarbon shell` / SSH, and compose-ha replication runs over WireGuard
 * (5433, never a provider firewall rule here). So no compose firewall may
 * open 5432 or 6543, and `vibecarbon access` rewrites only SSH and the k8s
 * API.
 *
 * The rules are checked as the programs build them, not as source text:
 * each provider SDK is replaced by a recorder, the Pulumi program runs, and
 * every inbound rule handed to a resource constructor is expanded to the
 * ports it covers. A port written as a range ('5000-6000'), held in a named
 * constant, or a rule with no port at all (every port) is caught the same
 * as a literal 5432.
 */

const { created } = vi.hoisted(() => ({
  created: [] as Array<{ type: string; name: string; args: unknown }>,
}));

vi.mock('@pulumi/hcloud', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('hcloud', created),
);
vi.mock('@pulumi/digitalocean', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('digitalocean', created),
);
vi.mock('@ediri/vultr', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('vultr', created),
);
vi.mock('@pulumi/linode', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('linode', created),
);
vi.mock('@pulumiverse/scaleway', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('scaleway', created),
);

const DB_PORTS = [5432, 6543];
const PORT_KEYS = ['port', 'portRange', 'ports'];

/** Every port a rule's port value covers: 22, '22', '80-443', '22,80', '1:65535'. */
function expandPorts(value: unknown): Array<[number, number]> {
  if (typeof value === 'number') return [[value, value]];
  return String(value)
    .split(',')
    .map((part) => {
      const [lo, hi = lo] = part.trim().split(/[-:]/).map(Number);
      return [lo, hi] as [number, number];
    });
}

/**
 * Inbound rule objects anywhere under a resource's args. Outbound subtrees
 * (DO/Linode/Scaleway `outbound*`, Hetzner `direction: 'out'`) are skipped.
 */
function inboundRules(node: unknown, out: Record<string, unknown>[] = []) {
  if (Array.isArray(node)) {
    for (const item of node) inboundRules(item, out);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.direction === 'out') return out;
    const isRule = 'protocol' in obj || PORT_KEYS.some((k) => k in obj);
    if (isRule) out.push(obj);
    for (const [key, value] of Object.entries(obj)) {
      if (/^outbound/i.test(key)) continue;
      inboundRules(value, out);
    }
  }
  return out;
}

function coveredPorts(rule: Record<string, unknown>): Array<[number, number]> {
  const key = PORT_KEYS.find((k) => rule[k] !== undefined);
  if (key) return expandPorts(rule[key]);
  if (/icmp/i.test(String(rule.protocol ?? ''))) return [];
  return [[1, 65535]];
}

const PROGRAMS = {
  hetzner: 'buildHetznerComposeProgram',
  digitalocean: 'buildDigitalOceanComposeProgram',
  vultr: 'buildVultrComposeProgram',
  linode: 'buildLinodeComposeProgram',
  scaleway: 'buildScalewayComposeProgram',
} as const;
const PROVIDERS = Object.keys(PROGRAMS) as Array<keyof typeof PROGRAMS>;

async function builtRules(provider: keyof typeof PROGRAMS) {
  const mod = await import(`../../../src/lib/iac/programs/${provider}-compose.js`);
  const builder = PROGRAMS[provider];
  created.length = 0;
  const program = mod[builder]({
    projectName: 'p',
    environment: 'e',
    sshPublicKey: 'ssh-ed25519 AAAA',
    location: 'fsn1',
    region: 'nyc3',
    serverType: 'cx23',
    labels: {},
    allowedSshIps: ['203.0.113.7/32', '2001:db8::/64'],
  });
  await program();
  return created.flatMap((r) => inboundRules(r.args));
}

describe('expandPorts', () => {
  it('reads single ports, ranges and lists', () => {
    expect(expandPorts(22)).toEqual([[22, 22]]);
    expect(expandPorts('5000-6000')).toEqual([[5000, 6000]]);
    expect(expandPorts('1:65535')).toEqual([[1, 65535]]);
    expect(expandPorts('22, 80')).toEqual([
      [22, 22],
      [80, 80],
    ]);
  });
});

describe('compose firewalls publish no database port', () => {
  it.each(PROVIDERS)(
    '%s-compose program builds no inbound rule covering 5432 or 6543',
    async (provider) => {
      const rules = await builtRules(provider);
      // The recorder saw the real firewall: SSH, HTTP and HTTPS are there.
      const covered = rules.flatMap(coveredPorts);
      for (const port of [22, 80, 443]) {
        expect(
          covered.some(([lo, hi]) => lo <= port && port <= hi),
          `${provider} opens ${port}`,
        ).toBe(true);
      }
      for (const port of DB_PORTS) {
        const hit = rules.find((rule) =>
          coveredPorts(rule).some(([lo, hi]) => lo <= port && port <= hi),
        );
        expect(hit, `${provider}-compose opens ${port}: ${JSON.stringify(hit)}`).toBeUndefined();
      }
    },
  );
});

describe('operator CIDR rewrites touch only SSH and the k8s API', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');
  it.each(PROVIDERS)('%s.js locks only SSH (22) and the k8s API (6443)', (provider) => {
    const src = read(`src/lib/providers/${provider}.js`);
    expect(src).toMatch(/const OPERATOR_LOCKED_PORTS = new Set\(\[SSH_PORT, K8S_API_PORT\]\);/);
    expect(src).toMatch(/const SSH_PORT = '?22'?;/);
    expect(src).toMatch(/const K8S_API_PORT = '?6443'?;/);
    expect(src).not.toMatch(/POOLER_/);
  });
});
