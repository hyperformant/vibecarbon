/**
 * The creates an earlier run started and didn't finish, as the seal finds
 * them in a stack's state after the deploy's refresh and up, and what has to
 * be true before the deploy drops them so it can seal (lib/iac/index.js
 * resolvePendingCreates runs it).
 *
 * Only creates are left by then: a refresh drops a pending update or delete,
 * and neither a refresh nor an up drops a pending create (CLI 3.259.0, the
 * fake cloud, 2026-11-11). A pending create is the only record of a resource
 * the provider may have made, and `stack import`, which the seal runs, drops
 * it with only a warning (Task 7 review). So the seal never imports over one.
 * The deploy clears them with the SDK's refresh({ clearPendingCreates: true })
 * once nothing they may have made is left running untracked:
 *   - a server is looked up by the name the program gave it (`nameInput`),
 *     and one the provider lists is vibecarbon's only when it carries the
 *     ownership labels the create recorded (`labelsInput`: SERVER_OWNER_LABELS,
 *     `project`, `environment`, which every program sets on its servers at
 *     create time). One of ours the state doesn't track is running untracked
 *     and billing, and the user deletes it in the console. A same-name server
 *     without those labels isn't ours: it's left alone and never named as one
 *     to delete. When none of ours is listed, the create made nothing that
 *     survived;
 *   - vibecarbon has no lookup for any other resource, nor a way to tell a
 *     server it made from another of the same name when the create recorded
 *     no ownership labels. The user is told to check the console, and the
 *     deploy after the one that said so clears it. The ledger keeps what was
 *     reported (pendingReported), so "then deploy again" is what clears it.
 *     An up re-makes a resource the program still declares whose create was
 *     left pending, tracks it at the same URN and keeps the record (3.259.0,
 *     the fake cloud, Task 7 review): that one is live and this project's, so
 *     the user is told its id as the one to keep and asked only about
 *     another of that type and name besides it. A program that declares the
 *     resource under a new name in the code tracks it at another URN: the one
 *     resource the state tracks with the create's type and console name is
 *     then the one to keep. A record with neither (the program no longer
 *     declares it, or two tracked resources share that name) is told as
 *     before.
 *
 * A resource is named as the provider's console shows it (its `name`,
 * `label` or Vultr's `description`), else as "an unnamed <type>", never by
 * its name in the program, which no console shows.
 *
 * Never logs or prints an input value beyond a resource's name.
 */

import { SERVER_OWNER_LABELS } from './create-timeout.js';

/**
 * @typedef {Record<string, string>} Ownership
 * @typedef {{ urn: string, noun: string, name: string, owner: Ownership }} PendingServer
 * @typedef {{ id: string, name: string | null }} Kept
 * @typedef {{ urn: string, what: string, name: string | null, billing: boolean, kept: Kept | null }} PendingOther
 * @typedef {PendingServer & { id: string }} ListedServer
 */

/**
 * The labels that make a server vibecarbon's, as the destroy sweep's
 * isEnvironmentOwnedServer reads them too.
 */
export const OWNERSHIP_KEYS = Object.freeze([
  ...Object.keys(SERVER_OWNER_LABELS),
  'project',
  'environment',
]);

/**
 * The ownership labels a create recorded in its `labelsInput`: a map on
 * Hetzner, `key:value` tags on the others, split on the first `:` as each
 * provider's decodeLabels does (a tag's characters and Linode's squeeze are
 * the same on the server the create made, so the two compare as written).
 * Null unless it recorded every ownership key and SERVER_OWNER_LABELS' values.
 * @param {Record<string, unknown> | undefined} inputs
 * @param {string | undefined} labelsInput
 * @returns {Ownership | null}
 */
export function recordedOwnership(inputs, labelsInput) {
  const raw = labelsInput ? inputs?.[labelsInput] : undefined;
  /** @type {Record<string, unknown>} */
  const labels = {};
  if (Array.isArray(raw)) {
    for (const tag of raw) {
      if (typeof tag !== 'string') continue;
      const sep = tag.indexOf(':');
      if (sep > 0) labels[tag.slice(0, sep)] = tag.slice(sep + 1);
    }
  } else if (raw && typeof raw === 'object') {
    Object.assign(labels, raw);
  }
  /** @type {Ownership} */
  const owner = {};
  for (const key of OWNERSHIP_KEYS) {
    const value = labels[key];
    if (typeof value !== 'string' || !value) return null;
    owner[key] = value;
  }
  for (const [key, value] of Object.entries(SERVER_OWNER_LABELS)) {
    if (owner[key] !== value) return null;
  }
  return owner;
}

/**
 * `deployment`'s pending operations, split into the server creates the
 * provider can be asked about and everything else. Each other one carries
 * `kept`: the resource the state tracks at its URN (an up made it again),
 * else the only one it tracks with the create's type and console name (an up
 * made it again under a new URN), or null when there is none.
 * @param {{ deployment?: { resources?: Array<{ urn?: string, id?: unknown, delete?: boolean, inputs?: Record<string, unknown>, outputs?: Record<string, unknown> }>, pending_operations?: Array<{ type?: string, resource?: { urn?: string, type?: string, inputs?: Record<string, unknown> } }> } }} deployment
 * @param {Readonly<Record<string, { noun: string, nameInput: string, labelsInput: string }>>} types - SERVER_RESOURCE_TYPES
 * @returns {{ servers: PendingServer[], others: PendingOther[] }}
 */
export function classifyPendingCreates(deployment, types) {
  const { byUrn, byTypeAndName } = trackedResources(deployment);
  const servers = [];
  const others = [];
  for (const op of deployment?.deployment?.pending_operations ?? []) {
    const resource = op?.resource ?? {};
    const urn = String(resource.urn ?? '');
    const serverClass = types[resource.type];
    const name = serverClass ? resource.inputs?.[serverClass.nameInput] : undefined;
    const owner = serverClass ? recordedOwnership(resource.inputs, serverClass.labelsInput) : null;
    if (op?.type === 'creating' && serverClass && typeof name === 'string' && name && owner) {
      servers.push({ urn, noun: serverClass.noun, name, owner });
    } else {
      const consoleName = nameOf(resource.inputs);
      const sameName = consoleName
        ? byTypeAndName.get(typeAndName(resource.type, consoleName))
        : [];
      others.push({
        urn,
        what: serverClass?.noun ?? kindOf(resource.type),
        name: consoleName,
        billing: Boolean(serverClass) || bills(resource.type),
        kept: byUrn.get(urn) ?? (sameName?.length === 1 ? sameName[0] : null),
      });
    }
  }
  return { servers, others };
}

/** The key a resource's type and console name are looked up by. */
const typeAndName = (type, name) => `${type}\0${name}`;

/**
 * The resources the state tracks, by URN and by type and console name, with
 * the id (as the console shows it, bareId) and name each has at the provider.
 * One being deleted (a replace's old half) is never the one to keep.
 * @returns {{ byUrn: Map<string, Kept>, byTypeAndName: Map<string, Kept[]> }}
 */
function trackedResources(deployment) {
  const byUrn = new Map();
  const byTypeAndName = new Map();
  for (const r of deployment?.deployment?.resources ?? []) {
    if (!r?.urn || r.id == null || r.id === '' || r.delete) continue;
    const kept = { id: bareId(r.id), name: nameOf(r.outputs) ?? nameOf(r.inputs) };
    byUrn.set(String(r.urn), kept);
    if (kept.name && r.type) {
      const key = typeAndName(r.type, kept.name);
      byTypeAndName.set(key, [...(byTypeAndName.get(key) ?? []), kept]);
    }
  }
  return { byUrn, byTypeAndName };
}

/** The class name in a Pulumi type token: `hcloud:index/floatingIp:FloatingIp` → `FloatingIp`. */
const classOf = (type) =>
  String(type ?? '')
    .split(':')
    .pop() || 'resource';

/** Words a type token spells in camel case that read as acronyms. */
const ACRONYMS = new Set(['ip', 'ssh', 'vpc']);

/** `hcloud:index/floatingIp:FloatingIp` → `floating IP`, `vultr:index/sSHKey:SSHKey` → `SSH key`. */
function kindOf(type) {
  return classOf(type)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()))
    .join(' ');
}

/** Whether a resource of `type` is billed while it exists: volumes, IPs, load balancers, buckets. */
const bills = (type) => /(Volume|Ip|LoadBalancer|Bucket)$/.test(classOf(type));

/**
 * The name a resource has at the provider, as its console lists it: `name`,
 * `label` (Linode, Vultr), or `description` (a Vultr firewall group's only
 * name). Null for one with none (a Scaleway flexible IP, a Linode reserved
 * IP): its name in the program is in no console.
 * @param {Record<string, unknown> | undefined} fields - a resource's inputs or outputs
 * @returns {string | null}
 */
function nameOf(fields) {
  for (const key of ['name', 'label', 'description']) {
    const value = fields?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * A create as the progress log names it: `firewall p-e1-firewall`,
 * `unnamed IP`, `server p-e1-worker-1`.
 * @param {PendingServer | PendingOther} create
 */
export function pendingLabel(create) {
  const what = 'what' in create ? create.what : create.noun;
  return create.name ? `${what} ${create.name}` : `unnamed ${what}`;
}

/**
 * A provider id as the API and its console spell it. Scaleway's state puts the
 * resource's zone (`fr-par-1/`) or region (`fr-par/`) in front, and only that
 * goes: another provider's id keeps every `/` of its own, as Hetzner's subnet
 * id `<network id>-10.0.1.0/24` does.
 */
const SCALEWAY_LOCALITY_PREFIX = /^[a-z]{2}-[a-z]{3}(?:-\d+)?\//;
const bareId = (id) => String(id).replace(SCALEWAY_LOCALITY_PREFIX, '');

/**
 * The servers the provider lists under a pending create's name that no server
 * in the state has the id of, split by whether each carries the ownership
 * labels the create recorded (`ours`: running untracked, the create's own) or
 * not (`foreign`: someone else's server that shares the name, left alone).
 * Rejects when the provider can't list every server (findServersByName's
 * strict mode): an empty answer then would drop the record of a server that
 * may exist.
 * @param {PendingServer[]} servers
 * @param {{ deployment?: { resources?: Array<{ type?: string, id?: unknown }> } }} deployment
 * @param {Readonly<Record<string, object>>} types - SERVER_RESOURCE_TYPES
 * @param {{ findServersByName: (name: string, options: { strict: boolean }) => Promise<Array<{ id: unknown }>>, serverLabels: (server: object) => Record<string, string> }} client
 * @returns {Promise<{ ours: ListedServer[], foreign: ListedServer[] }>}
 */
export async function untrackedServers(servers, deployment, types, client) {
  const tracked = new Set(
    (deployment?.deployment?.resources ?? [])
      .filter((r) => r?.type in types && r.id != null && r.id !== '')
      .map((r) => bareId(r.id)),
  );
  /** @type {Map<string, ListedServer>} */
  const ours = new Map();
  /** @type {Map<string, ListedServer>} */
  const foreign = new Map();
  for (const server of servers) {
    for (const listed of await client.findServersByName(server.name, { strict: true })) {
      const id = bareId(listed.id);
      if (tracked.has(id) || ours.has(id) || foreign.has(id)) continue;
      const labels = client.serverLabels(listed) ?? {};
      const mine = OWNERSHIP_KEYS.every((key) => labels[key] === server.owner[key]);
      (mine ? ours : foreign).set(id, { ...server, id });
    }
  }
  return { ours: [...ours.values()], foreign: [...foreign.values()] };
}

/** The ledger step that records which unfinished creates of `stackName` the user was told about. */
export function pendingReportStep(stackName) {
  return `state-seal-pending ${stackName}`;
}

/** The record's inputs: the reported creates, in an order that doesn't depend on the state's. */
const reportInputs = (others) => ({ urns: others.map((o) => o.urn).sort() });

/**
 * Whether the ledger says the user was already told about exactly these
 * creates, so this deploy is the "deploy again" the message asked for.
 * @param {{ shouldSkip: (step: string, inputs: object) => boolean }} ledger
 * @param {string} stackName
 * @param {PendingOther[]} others
 */
export function pendingReported(ledger, stackName, others) {
  return ledger.shouldSkip(pendingReportStep(stackName), reportInputs(others));
}

/**
 * Record that the user was told about these creates.
 * @param {{ startStep: (step: string, inputs: object) => void, completeStep: (step: string, result?: object) => void }} ledger
 * @param {string} stackName
 * @param {PendingOther[]} others
 */
export function recordPendingReported(ledger, stackName, others) {
  ledger.startStep(pendingReportStep(stackName), reportInputs(others));
  ledger.completeStep(pendingReportStep(stackName), {});
}

/**
 * Forget the record, once the creates it named are cleared.
 * @param {{ invalidateStep: (step: string) => void }} ledger
 * @param {string} stackName
 */
export function forgetPendingReported(ledger, stackName) {
  ledger.invalidateStep(pendingReportStep(stackName));
}

/** `a`, `a and b`, `a, b and c` (or `a or b` with `joiner` 'or'). */
function listing(items, joiner = 'and') {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`;
}

/** A sentence that starts with a lowercase name, capitalized. */
const capitalized = (sentence) => sentence[0].toUpperCase() + sentence.slice(1);

/** `the floating IP p-e1-ip`, `an unnamed IP`: a resource as the console shows it. */
const theOther = (o) => (o.name ? `the ${o.what} ${o.name}` : `an unnamed ${o.what}`);

/** `the floating IP p-e1-ip (id 4711)`, `an unnamed IP (id 0b1c…)`: the one the state tracks. */
const theKept = (o) =>
  `${o.kept.name ? `the ${o.what} ${o.kept.name}` : `an unnamed ${o.what}`} (id ${o.kept.id})`;

/** `another floating IP named p-e1-ip`, `another unnamed IP`: what the earlier create may have made. */
const another = (o) => (o.name ? `another ${o.what} named ${o.name}` : `another unnamed ${o.what}`);

const opening = (stackName) =>
  `Your servers in ${stackName} are updated, but vibecarbon left their user data in plain text in the Pulumi state.`;

/**
 * What the user reads when unfinished creates may have left something in
 * their account: servers of ours the provider lists untracked, resources
 * vibecarbon can't tell were made, and resources a later run made again,
 * which the user keeps (named by id), with only another of the same type and
 * name to look for. Names each one that bills while it exists, never the one
 * to keep. Each needs the console, then another deploy, which clears the
 * records and seals. A server that only shares a name is never in it.
 * @param {string} stackName
 * @param {{ untracked: ListedServer[], others: PendingOther[], providerName: string }} found
 */
export function pendingCreatesBlock(stackName, { untracked, others, providerName }) {
  const items = [...untracked.map((s) => `the ${s.noun} ${s.name}`), ...others.map(theOther)];
  const many = items.length > 1;
  const sentences = [
    opening(stackName),
    `An earlier run started creating ${listing(items)} and didn't finish, and the state keeps ${many ? 'a record of each create' : 'a record of that create'}, which has to go before vibecarbon can seal it.`,
  ];
  if (untracked.length > 0) {
    const them = untracked.length > 1;
    sentences.push(
      `${listing(untracked.map((s) => `${s.name} (id ${s.id})`))} ${them ? 'are' : 'is'} running in your account without Pulumi tracking ${them ? 'them' : 'it'}, so you're billed for ${them ? 'them' : 'it'} and no vibecarbon command will remove ${them ? 'them' : 'it'}: delete ${them ? 'them' : 'it'} in your ${providerName} console.`,
    );
  }
  const unconfirmed = others.filter((o) => !o.kept);
  if (unconfirmed.length > 0) {
    const them = unconfirmed.length > 1;
    sentences.push(
      `vibecarbon can't tell whether ${them ? 'those creates' : 'that create'} made ${listing(unconfirmed.map(theOther))}, so check your ${providerName} console for ${them ? 'them' : 'it'} and delete ${them ? "any that are this project's" : "it if it's this project's"}.`,
    );
    const billing = unconfirmed.filter((o) => o.billing);
    if (billing.length > 0) {
      sentences.push(
        capitalized(
          `${listing(billing.map(theOther))} may be billing you while ${billing.length > 1 ? 'they exist' : 'it exists'}.`,
        ),
      );
    }
  }
  const remade = others.filter((o) => o.kept);
  if (remade.length > 0) {
    const them = remade.length > 1;
    sentences.push(
      `Keep ${listing(remade.map(theKept))}: a later run made ${them ? 'them' : 'it'} again, and ${them ? "they're the ones" : "it's the one"} this project uses.`,
      `vibecarbon can't tell whether the earlier ${them ? 'creates' : 'create'} also made ${listing(remade.map(another), 'or')}, so check your ${providerName} console for ${them ? 'those' : 'one'} and delete ${them ? "any that are this project's" : "it if it's this project's"}.`,
    );
    const billing = remade.filter((o) => o.billing);
    if (billing.length > 0) {
      sentences.push(
        capitalized(
          `${listing(billing.map(another))} would be billing you while ${billing.length > 1 ? 'they exist' : 'it exists'}.`,
        ),
      );
    }
  }
  sentences.push(
    `Then deploy again: the next deploy clears ${many ? 'the records' : 'the record'} and seals the state.`,
  );
  return sentences.join(' ');
}

/**
 * What the user reads when the provider couldn't say whether a server an
 * unfinished create may have made exists.
 * @param {string} stackName
 * @param {PendingServer[]} servers
 * @param {string} reason - the lookup's own error, which names the provider
 */
export function pendingLookupFailed(stackName, servers, reason) {
  const them = servers.length > 1;
  return [
    opening(stackName),
    `An earlier run started creating ${listing(servers.map((s) => `the ${s.noun} ${s.name}`))} and didn't finish.`,
    `Before it drops ${them ? 'the records of those creates' : 'the record of that create'}, vibecarbon checks whether ${them ? 'those servers exist' : 'that server exists'}, and the check failed (${reason.replace(/\.$/, '')}).`,
    'The next deploy checks again.',
  ].join(' ');
}
