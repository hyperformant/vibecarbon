/**
 * The Vultr resources a `pulumi refresh` cannot drop when they are gone,
 * found before it so they can be dropped first.
 *
 * terraform-provider-vultr v2.27.1 (bridged by @ediri/vultr) reads a resource
 * as gone only when the API's error contains one exact phrase. For four types
 * that phrase is not what the API says. Measured 2026-11-27, one GET of a
 * missing id each:
 *
 *   type          the provider's Read looks for     Vultr answers 404 with
 *   Instance      invalid instance ID               {"error":"instance not found","status":404}
 *   Vpc           Invalid VPC ID                    {"is_external_error":false,"error":"VPC not found.","status":404}
 *   ReservedIp    Invalid reserved-ip ID            {"error":"reserved ip not found","status":404}
 *   FirewallRule  Firewall rule ID not found        {"is_external_error":false,"error":"Firewall Rule Not Found","status":404}
 *
 * So the Read returns the 404 as an error, and the refresh fails on a
 * resource that is already gone (`error: update failed`) instead of dropping
 * it. A destroy then deletes it by id and gets the same 404. E2e run
 * 45922250720 (vultr k8s): the first destroy failed on the reserved IP, the
 * backstop released it, and the destroy that ran once more failed its refresh
 * and then its delete ("Invalid reserved-ip ID."), so the environment was
 * kept and reported UNVERIFIED.
 *
 * FirewallGroup (`"status":404`) and SSHKey (`Invalid ssh key`, measured
 * `{"error":"Invalid ssh key.","status":404}`) match, so the refresh drops
 * those itself. The census (tests/unit/iac/vultr-gone-resources-census.test.ts)
 * holds every Vultr type a program declares to one of the two lists, with
 * these bodies as fixtures, so a new type fails until it is classified.
 *
 * Only Vultr's own not-found for that id counts: an HTTP 404 whose `error` is
 * the type's wording. Any other answer (2xx, 401, 403, another 404, a 5xx
 * fetchWithRetry could not get past, a network error) leaves the resource in
 * state for the refresh to read. Remove a type from VULTR_GONE_PROBES once
 * the provider's Read matches the API's wording; its fixture then moves to
 * VULTR_READ_PRUNES.
 */

/** Pulumi type tokens (`vultr.<Class>.__pulumiType`). */
const INSTANCE = 'vultr:index/instance:Instance';
const VPC = 'vultr:index/vpc:Vpc';
const RESERVED_IP = 'vultr:index/reservedIp:ReservedIp';
const FIREWALL_RULE = 'vultr:index/firewallRule:FirewallRule';

/** A Vultr API id: a uuid, or a firewall rule's number. Anything else is never put in a path. */
const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** A string state field, from outputs first (what the provider last read), then inputs. */
const field = (r, key) => {
  for (const side of [r?.outputs, r?.inputs]) {
    const value = side?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
};

/** `/<collection>/<id>` for a resource whose state id is its API id, else null. */
const byId = (collection) => (r) =>
  typeof r?.id === 'string' && SAFE_ID.test(r.id) ? `${collection}/${r.id}` : null;

/**
 * A firewall rule's path: its state id is the rule's number
 * (resourceVultrFirewallRuleCreate's `d.SetId(strconv.Itoa(rule.ID))`), and
 * its group is `firewallGroupId`. An imported one may carry
 * `<group>,<rule>` (resourceVultrFirewallRuleImport). A rule under a group
 * that is gone answers the same 404 (measured), so it reads as gone too.
 * @param {{id?: string, inputs?: object, outputs?: object}} r
 * @returns {string|null}
 */
function firewallRulePath(r) {
  if (typeof r?.id !== 'string') return null;
  let group = field(r, 'firewallGroupId');
  let rule = r.id;
  const comma = r.id.indexOf(',');
  if (comma !== -1) {
    group = r.id.slice(0, comma);
    rule = r.id.slice(comma + 1);
  }
  if (!group || !SAFE_ID.test(group) || !/^\d+$/.test(rule)) return null;
  return `/firewalls/${group}/rules/${rule}`;
}

/**
 * The types the refresh cannot drop: how to GET one by id, the provider
 * Read's phrase (which Vultr's 404 does not contain), and Vultr's own
 * not-found wording for it.
 * @type {Readonly<Record<string, {path: (r: object) => string|null, readLooksFor: string, notFound: RegExp}>>}
 */
export const VULTR_GONE_PROBES = Object.freeze({
  [INSTANCE]: {
    path: byId('/instances'),
    readLooksFor: 'invalid instance ID',
    notFound: /^instance not found\.?$/i,
  },
  [VPC]: {
    path: byId('/vpcs'),
    readLooksFor: 'Invalid VPC ID',
    notFound: /^VPC not found\.?$/i,
  },
  [RESERVED_IP]: {
    path: byId('/reserved-ips'),
    readLooksFor: 'Invalid reserved-ip ID',
    notFound: /^reserved ip not found\.?$/i,
  },
  [FIREWALL_RULE]: {
    path: firewallRulePath,
    readLooksFor: 'Firewall rule ID not found',
    notFound: /^firewall rule not found\.?$/i,
  },
});

/**
 * The types whose provider Read already drops a 404 from state, with the
 * phrase it looks for (Vultr's 404 body contains it).
 * @type {Readonly<Record<string, string>>}
 */
export const VULTR_READ_PRUNES = Object.freeze({
  'vultr:index/firewallGroup:FirewallGroup': '"status":404',
  'vultr:index/sSHKey:SSHKey': 'Invalid ssh key',
});

/**
 * Probed types no program declares any more, each with why it stays probed.
 * @type {Readonly<Record<string, string>>}
 */
export const VULTR_PROBED_UNDECLARED = Object.freeze({
  [RESERVED_IP]:
    'vultr-k8s.js made one until 2026-11-27 (never released); a stack it ran on can still list one',
});

/**
 * @typedef {Object} GoneVultrResource
 * @property {string} urn
 * @property {string} type
 * @property {string} name - the logical name (the URN's last segment)
 * @property {string} id
 * @property {string} said - Vultr's own not-found text
 */

/**
 * The resources of `state` Vultr says are gone: each one of a probed type is
 * read by id (`provider.readResourceStatus`, all at once), and only an HTTP
 * 404 whose `error` is that type's not-found wording counts. A resource
 * whose URN another state entry shares (the older copy of a replacement,
 * awaiting its delete) counts only when every entry with that URN is gone,
 * since the drop goes by URN. Never throws: a read that throws (the network)
 * leaves its resource in state.
 *
 * @param {{ deployment?: { resources?: object[] } }} state - exportStack's result
 * @param {{ readResourceStatus: (endpoint: string) => Promise<{status: number, error: string|null}> }} provider
 * @returns {Promise<GoneVultrResource[]>} in state order, one per URN
 */
export async function findGoneVultrResources(state, provider) {
  const resources = state?.deployment?.resources ?? [];
  const asked = resources.map((r) => {
    const probe = VULTR_GONE_PROBES[r?.type];
    const endpoint = probe?.path(r) ?? null;
    return { r, probe, endpoint };
  });
  const answers = await Promise.all(
    asked.map(async ({ probe, endpoint }) => {
      if (!endpoint) return null;
      try {
        const { status, error } = await provider.readResourceStatus(endpoint);
        if (status !== 404 || typeof error !== 'string') return null;
        return probe.notFound.test(error.trim()) ? error.trim() : null;
      } catch {
        return null;
      }
    }),
  );
  const entriesOf = new Map();
  for (const { r } of asked) entriesOf.set(r?.urn, (entriesOf.get(r?.urn) ?? 0) + 1);
  const goneOf = new Map();
  asked.forEach(({ r }, i) => {
    if (answers[i] !== null) goneOf.set(r.urn, [...(goneOf.get(r.urn) ?? []), i]);
  });
  const gone = [];
  for (const [urn, indexes] of goneOf) {
    if (indexes.length !== entriesOf.get(urn)) continue;
    const { r } = asked[indexes[0]];
    gone.push({
      urn,
      type: r.type,
      name: String(urn).split('::').pop(),
      id: r.id,
      said: answers[indexes[0]],
    });
  }
  return gone;
}
