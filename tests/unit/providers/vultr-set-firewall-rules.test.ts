/**
 * VultrProvider.setFirewallRules — read-vs-create shape safety.
 *
 * Vultr is the one provider whose rule replace is delete-then-recreate
 * against a POST endpoint STRICTER than the GET shape: rows read back from
 * `/firewalls/<id>/rules` carry `source`, `type`, `action`, `direction`,
 * and `loadbalancer_id`, and POSTing a recycled row fails with
 * "Invalid source group". Both in-repo rule builders
 * (buildReplicationFirewallRules, applyOperatorCidrs) recycle read rows,
 * so without projection the replace DELETES every rule and then fails to
 * recreate them — the live v2 warm-deploy RCA of 2026-08-19: both HA
 * firewalls left holding only the WG rule, 443 dark. (Linode/Scaleway
 * replace via atomic set-style PUTs whose write schema accepts their read
 * shape, and Hetzner's set_rules is atomic — the class is Vultr-only.)
 *
 * The contract pinned here:
 *  1. setFirewallRules projects every row to the documented create shape
 *     ({ip_type, protocol, port?, subnet, subnet_size, notes?}) before
 *     POSTing — read-only fields never reach the wire.
 *  2. Projection + validation happen BEFORE the first DELETE, so a
 *     malformed set aborts while the live rules are still intact
 *     (delete-then-recreate must never wipe a firewall it cannot refill).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetry = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
}));

import { VultrProvider } from '../../../src/lib/providers/vultr.js';

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

  it('a rule missing a create-required field aborts BEFORE the first DELETE (never wipes what it cannot refill)', async () => {
    const { provider, posts } = makeProvider();
    const badRule = { protocol: 'tcp', port: '443', subnet: '0.0.0.0', subnet_size: 0 }; // no ip_type

    await expect(provider.setFirewallRules('gid-1', [badRule])).rejects.toThrow(/ip_type/);

    // No DELETE was issued (fetchWithRetry is the DELETE transport) and no POST either.
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it('a non-integer subnet_size aborts before the first DELETE too', async () => {
    const { provider, posts } = makeProvider();
    const badRule = { ip_type: 'v4', protocol: 'tcp', port: '443', subnet: '0.0.0.0' };

    await expect(provider.setFirewallRules('gid-1', [badRule])).rejects.toThrow(/subnet_size/);
    expect(fetchWithRetry).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
});
