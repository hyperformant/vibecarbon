/**
 * VultrProvider.setFirewallRules: a minimal diff, and read-vs-create shape
 * safety.
 *
 * Vultr has no replace-all endpoint and its rules are immutable
 * sub-resources with their own ids. The k8s program owns some of a group's
 * rules (the web and the VPC), REST owns the rest (the operator ports, the
 * k8s-ha replication rule: ruling RV5, one writer per rule), and the next
 * up's refresh finds the program's rules by id. So a REST rewrite leaves
 * every rule it keeps where it is: it lists the live rules, creates the ones
 * the target adds, then deletes the ones it drops. A wholesale rewrite gave
 * every rule a new id, so the next up lost the program's and created them
 * again ("This rule is already defined"), and it emptied the group on the
 * way: Vultr does not enforce a group with no rules, so the nodes were open.
 *
 * The create endpoint is also STRICTER than the GET shape: rows read back
 * from `/firewalls/<id>/rules` carry `source`, `type`, `action`,
 * `direction`, and `loadbalancer_id`, and POSTing a recycled row fails with
 * "Invalid source group". Both in-repo rule builders
 * (buildReplicationFirewallRules, applyOperatorCidrs) recycle read rows
 * (the live v2 warm-deploy RCA of 2026-08-19: both HA firewalls left holding
 * only the WG rule, 443 dark).
 *
 * The contract pinned here:
 *  1. Every row is projected to the documented create shape
 *     ({ip_type, protocol, port?, subnet, subnet_size, notes?}) before it is
 *     POSTed: read-only fields never reach the wire.
 *  2. Projection and validation happen before the first write, so a
 *     malformed set aborts while the live rules are intact.
 *  3. A rule the target keeps keeps its id; only the rules it adds are
 *     created and only the ones it drops are deleted, creates first, so the
 *     group never has no rule. An empty target is refused.
 *  4. The end state is the target, as the wholesale rewrite left it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetry = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
}));

import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { ruleFields, vultrFirewallApi } from '../../_shared/vultr-firewall-api.js';

// A row exactly as GET /v2/firewalls/<id>/rules returns it — the recycled
// shape both rule builders feed back in. `source` is the field the create
// endpoint rejects ("Invalid source group").
const READ_SHAPED_HTTP_RULE = {
  id: 7,
  type: 'v4',
  ip_type: 'v4',
  action: 'accept',
  protocol: 'tcp',
  port: '443',
  subnet: '0.0.0.0',
  subnet_size: 0,
  source: '0.0.0.0/0',
  notes: 'https',
  direction: 'in',
  loadbalancer_id: '',
};

const CREATE_SHAPE_KEYS = ['ip_type', 'protocol', 'port', 'subnet', 'subnet_size', 'notes'];

function makeProvider() {
  const provider = new VultrProvider('test-token');
  const posts: unknown[] = [];
  vi.spyOn(provider, '_walkCursor').mockResolvedValue({
    items: [{ id: 1 }, { id: 2 }],
    complete: true,
  });
  vi.spyOn(provider, 'apiRequest').mockImplementation(async (_path: string, opts: RequestInit) => {
    posts.push(JSON.parse(String(opts.body)));
    return { ok: true, json: async () => ({}) } as Response;
  });
  return { provider, posts };
}

beforeEach(() => {
  fetchWithRetry.mockReset();
  fetchWithRetry.mockResolvedValue({ ok: true, status: 204 });
});

describe('VultrProvider.setFirewallRules — create-shape projection', () => {
  it('projects recycled READ rows to exactly the create schema (no read-only fields on the wire)', async () => {
    const { provider, posts } = makeProvider();

    await provider.setFirewallRules('gid-1', [READ_SHAPED_HTTP_RULE]);

    expect(posts).toHaveLength(1);
    const body = posts[0] as Record<string, unknown>;
    // Values survive…
    expect(body).toMatchObject({
      ip_type: 'v4',
      protocol: 'tcp',
      port: '443',
      subnet: '0.0.0.0',
      subnet_size: 0,
      notes: 'https',
    });
    // …and NOTHING outside the documented create shape goes on the wire.
    for (const key of Object.keys(body)) {
      expect(CREATE_SHAPE_KEYS).toContain(key);
    }
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('action');
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('loadbalancer_id');
  });

  it('omits `port` for portless rules and `notes` when absent, instead of sending empty strings', async () => {
    const { provider, posts } = makeProvider();

    await provider.setFirewallRules('gid-1', [
      { ip_type: 'v4', protocol: 'icmp', subnet: '0.0.0.0', subnet_size: 0 },
    ]);

    const body = posts[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('port');
    expect(body).not.toHaveProperty('notes');
    expect(body).toMatchObject({ ip_type: 'v4', protocol: 'icmp' });
  });

  it('a rule missing a create-required field aborts before the first write', async () => {
    const { provider, posts } = makeProvider();
    const badRule = { protocol: 'tcp', port: '443', subnet: '0.0.0.0', subnet_size: 0 }; // no ip_type

    await expect(provider.setFirewallRules('gid-1', [badRule])).rejects.toThrow(/ip_type/);

    // No DELETE was issued (fetchWithRetry is the DELETE transport) and no POST either.
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it('a non-integer subnet_size aborts before the first write too', async () => {
    const { provider, posts } = makeProvider();
    const badRule = { ip_type: 'v4', protocol: 'tcp', port: '443', subnet: '0.0.0.0' };

    await expect(provider.setFirewallRules('gid-1', [badRule])).rejects.toThrow(/subnet_size/);
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
});

describe('VultrProvider.setFirewallRules: a minimal diff', () => {
  /** A rule in the create shape. */
  const rule = (protocol: string, port: string, subnet: string, size: number, notes: string) => ({
    ip_type: subnet.includes(':') ? 'v6' : 'v4',
    protocol,
    subnet,
    subnet_size: size,
    ...(port ? { port } : {}),
    notes,
  });
  const HTTPS = rule('tcp', '443', '0.0.0.0', 0, 'https');
  const HTTPS6 = rule('tcp', '443', '::', 0, 'https');
  const VPC = rule('tcp', '1:65535', '10.181.32.0', 24, 'vpc-tcp');
  const ICMP = rule('icmp', '', '10.181.32.0', 24, 'vpc-icmp');
  const SSH_A = rule('tcp', '22', '203.0.113.5', 32, 'operator-22');
  const SSH_B = rule('tcp', '22', '198.51.100.9', 32, 'operator-22');
  const WG = rule('udp', '51821', '198.51.100.7', 32, 'wg-replication');

  function group(live: Record<string, unknown>[]) {
    const api = vultrFirewallApi({ groupId: 'gid-1', description: 'acme-prod-firewall' });
    for (const r of live) {
      if (!api.create(r)) throw new Error(`fixture refused: ${JSON.stringify(r)}`);
    }
    api.calls.length = 0;
    fetchWithRetry.mockImplementation(api.fetch);
    return api;
  }
  /** The live rules as the target would name them: create shape, sorted. */
  const live = (api: ReturnType<typeof vultrFirewallApi>) =>
    [...api.rules.values()].map((r) => `${ruleFields(r)} ${r.notes}`).sort();
  const wanted = (target: Record<string, unknown>[]) =>
    [...new Set(target.map((r) => `${ruleFields(r)} ${r.notes}`))].sort();

  it('an unchanged set writes nothing', async () => {
    const api = group([HTTPS, VPC, ICMP, SSH_A]);
    await new VultrProvider('t').setFirewallRules('gid-1', [HTTPS, VPC, ICMP, SSH_A]);
    expect(api.calls).toEqual([]);
  });

  it('keeps the id of every rule the target keeps', async () => {
    const api = group([HTTPS, VPC, ICMP, SSH_A]);
    const kept = new Map(
      [...api.rules].filter(([, r]) => r.notes !== 'operator-22').map(([id, r]) => [id, { ...r }]),
    );
    expect(kept.size).toBe(3);

    // Read rows, as the rule builders hand them back (ids and read fields).
    const read = [...api.rules.values()].filter((r) => r.notes !== 'operator-22');
    await new VultrProvider('t').setFirewallRules('gid-1', [...read, SSH_B]);

    for (const [id, row] of kept) expect(api.rules.get(id)).toEqual(row);
    expect(api.calls.map((c) => `${c.method} ${c.rule}`)).toEqual([
      'POST v4 tcp 198.51.100.9/32 22',
      'DELETE v4 tcp 203.0.113.5/32 22',
    ]);
  });

  it('creates every added rule before it deletes a dropped one', async () => {
    const api = group([HTTPS, SSH_A]);
    await new VultrProvider('t').setFirewallRules('gid-1', [VPC, ICMP, SSH_B]);
    const methods = api.calls.map((c) => c.method);
    expect(methods).toEqual(['POST', 'POST', 'POST', 'DELETE', 'DELETE']);
    expect(api.state.emptied).toBe(false);
  });

  it('never leaves the group with no rule, even when the target shares none with it', async () => {
    const api = group([SSH_A]);
    await new VultrProvider('t').setFirewallRules('gid-1', [SSH_B]);
    expect(api.state.emptied).toBe(false);
    expect(live(api)).toEqual(wanted([SSH_B]));
  });

  it('refuses an empty target, which would leave the group unenforced', async () => {
    const api = group([HTTPS, SSH_A]);
    await expect(new VultrProvider('t').setFirewallRules('gid-1', [])).rejects.toThrow(/no rules/);
    expect(api.calls).toEqual([]);
    expect(api.rules.size).toBe(2);
  });

  it('a target naming one rule twice makes it once', async () => {
    const api = group([HTTPS]);
    await new VultrProvider('t').setFirewallRules('gid-1', [HTTPS, SSH_B, { ...SSH_B }]);
    expect(api.calls.map((c) => `${c.method} ${c.rule}`)).toEqual([
      'POST v4 tcp 198.51.100.9/32 22',
    ]);
  });

  it('a create Vultr refuses stops before any delete', async () => {
    const api = group([HTTPS, SSH_A]);
    const provider = new VultrProvider('t');
    fetchWithRetry.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? { ok: false, status: 400, json: async () => ({ error: 'This rule is already defined' }) }
        : api.fetch(url, init),
    );
    await expect(provider.setFirewallRules('gid-1', [HTTPS, SSH_B])).rejects.toThrow(
      /already defined/,
    );
    expect(api.calls).toEqual([]);
    expect(api.rules.size).toBe(2);
  });

  // Compose's group (vultr-compose.js: operator-22 per CIDR, http and https
  // from the world) and the k8s-ha replication write: whatever the live set,
  // the group ends as the target, as the wholesale rewrite left it.
  it.each([
    ['an access push to a new address', [HTTPS, HTTPS6, SSH_A], [HTTPS, HTTPS6, SSH_B]],
    ['an access push adding an address', [HTTPS, HTTPS6, SSH_A], [HTTPS, HTTPS6, SSH_A, SSH_B]],
    ['the replication write', [HTTPS, HTTPS6, SSH_A], [HTTPS, HTTPS6, SSH_A, WG]],
    ['a target sharing no rule', [HTTPS, SSH_A], [VPC, ICMP, WG]],
    ['an unchanged set', [HTTPS, SSH_A], [SSH_A, HTTPS]],
  ])('%s ends as the target', async (_case, before, target) => {
    const api = group(before);
    await new VultrProvider('t').setFirewallRules('gid-1', target);
    expect(live(api)).toEqual(wanted(target));
    expect(api.state.emptied).toBe(false);
  });
});
