/**
 * Vultr's firewall API for one group, for tests: what VultrProvider's REST
 * calls (findFirewallByName, setFirewallRules, applyOperatorCidrs) read and
 * write, served through a fetchWithRetry mock. Rules are immutable and keyed
 * by id, as Vultr's are. A POST that repeats a live rule's fields is refused
 * with Vultr's "This rule is already defined", and the listing returns the
 * read shape, with the fields the create endpoint rejects.
 *
 * `emptied` records whether a DELETE ever left the group with no rule: Vultr
 * does not enforce a group that has none, so its nodes would be open.
 * `partialListings` makes that many of the next rules listings break off
 * after their first page: one rule, then a 503 for the next page. With 1,
 * the read a rewrite builds from is partial and the one after it is whole.
 */

/** A rule as Vultr's rules listing returns it. */
export type VultrRuleRow = {
  id: number;
  ip_type: string;
  protocol: string;
  subnet: string;
  subnet_size: number;
  port: string;
  notes: string;
  [readOnly: string]: unknown;
};

/** The fields Vultr treats as one rule: a second rule with the same is refused. */
export const ruleFields = (r: { [k: string]: unknown }) =>
  `${r.ip_type} ${r.protocol} ${r.subnet}/${r.subnet_size} ${r.port ?? ''}`;

const API = 'https://api.vultr.com/v2';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

export function vultrFirewallApi({
  groupId,
  description,
}: {
  groupId: string;
  description: string;
}) {
  let nextId = 1;
  const rules = new Map<number, VultrRuleRow>();
  const calls: { method: 'POST' | 'DELETE'; id: number; rule: string }[] = [];
  const state = { emptied: false, partialListings: 0 };

  /** Make a rule, as Vultr's create endpoint does; null when it refuses. */
  function create(body: Record<string, unknown>): VultrRuleRow | null {
    for (const field of ['ip_type', 'protocol', 'subnet', 'subnet_size']) {
      if (body[field] === undefined) return null;
    }
    if ('source' in body || 'id' in body || 'action' in body) return null;
    if ([...rules.values()].some((r) => ruleFields(r) === ruleFields(body))) return null;
    const id = nextId++;
    const row: VultrRuleRow = {
      id,
      ip_type: String(body.ip_type),
      protocol: String(body.protocol),
      subnet: String(body.subnet),
      subnet_size: Number(body.subnet_size),
      port: body.port === undefined ? '' : String(body.port),
      notes: body.notes === undefined ? '' : String(body.notes),
      // Read-only fields the create endpoint rejects.
      type: body.ip_type,
      action: 'accept',
      source: '',
    };
    rules.set(id, row);
    calls.push({ method: 'POST', id, rule: ruleFields(row) });
    return row;
  }

  async function fetch(url: string, init?: RequestInit) {
    const method = init?.method ?? 'GET';
    const [path, query = ''] = (url.startsWith(API) ? url.slice(API.length) : url).split('?');
    if (method === 'GET' && path === '/firewalls') {
      return json({ firewall_groups: [{ id: groupId, description }], meta: {} });
    }
    if (method === 'GET' && path === `/firewalls/${groupId}/rules`) {
      const rows = [...rules.values()].map((r) => ({ ...r }));
      if (new URLSearchParams(query).get('cursor')) return json({ error: 'unavailable' }, 503);
      if (state.partialListings === 0) return json({ firewall_rules: rows, meta: {} });
      state.partialListings -= 1;
      return json({ firewall_rules: rows.slice(0, 1), meta: { links: { next: 'page-2' } } });
    }
    if (method === 'POST' && path === `/firewalls/${groupId}/rules`) {
      const row = create(JSON.parse(String(init?.body)));
      return row
        ? json({ firewall_rule: row }, 201)
        : json({ error: 'This rule is already defined' }, 400);
    }
    const del = path.match(new RegExp(`^/firewalls/${groupId}/rules/(\\d+)$`));
    if (method === 'DELETE' && del) {
      const id = Number(del[1]);
      const row = rules.get(id);
      if (!row) return json({ error: 'not found' }, 404);
      rules.delete(id);
      calls.push({ method: 'DELETE', id, rule: ruleFields(row) });
      if (rules.size === 0) state.emptied = true;
      return json({}, 204);
    }
    return json({ error: `unexpected ${method} ${path}` }, 404);
  }

  return {
    rules,
    calls,
    state,
    create,
    fetch,
    /** The live rules, as `ip_type protocol subnet/size port notes`, sorted. */
    summary: () => [...rules.values()].map((r) => `${ruleFields(r)} ${r.notes}`.trim()).sort(),
  };
}
