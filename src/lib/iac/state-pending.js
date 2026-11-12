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
 *
 * Never logs or prints an input value beyond a resource's name.
 */

import { SERVER_OWNER_LABELS } from './create-timeout.js';

/**
 * @typedef {Record<string, string>} Ownership
 * @typedef {{ urn: string, noun: string, name: string, owner: Ownership }} PendingServer
 * @typedef {{ urn: string, what: string, name: string, billing: boolean }} PendingOther
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
 * provider can be asked about and everything else.
 * @param {{ deployment?: { pending_operations?: Array<{ type?: string, resource?: { urn?: string, type?: string, inputs?: Record<string, unknown> } }> } }} deployment
 * @param {Readonly<Record<string, { noun: string, nameInput: string, labelsInput: string }>>} types - SERVER_RESOURCE_TYPES
 * @returns {{ servers: PendingServer[], others: PendingOther[] }}
 */
export function classifyPendingCreates(deployment, types) {
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
      others.push({
        urn,
        what: serverClass?.noun ?? kindOf(resource.type),
        name: nameOf(resource, urn),
        billing: Boolean(serverClass) || bills(resource.type),
      });
    }
  }
  return { servers, others };
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

/** The provider-side name a resource was given, else its name in the program. */
function nameOf(resource, urn) {
  const { name, label } = resource.inputs ?? {};
  if (typeof name === 'string' && name) return name;
  if (typeof label === 'string' && label) return label;
  return urn.split('::').pop() || urn;
}

/** A provider id as the state and the API both spell it: Scaleway's state adds `<zone>/`. */
const bareId = (id) => String(id).split('/').pop();

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

/** `a`, `a and b`, `a, b and c`. */
function listing(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** `the floating IP p-e1-ip`: a resource by its type and name. */
const theOther = (o) => `the ${o.what} ${o.name}`;

const opening = (stackName) =>
  `Your servers in ${stackName} are updated, but vibecarbon left their user data in plain text in the Pulumi state.`;

/**
 * What the user reads when unfinished creates may have left something in
 * their account: servers of ours the provider lists untracked, and resources
 * vibecarbon can't tell were made, naming each one that bills while it
 * exists. Each needs the console, then another deploy, which clears the
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
  if (others.length > 0) {
    const them = others.length > 1;
    sentences.push(
      `vibecarbon can't tell whether ${them ? 'those creates' : 'that create'} made ${listing(others.map(theOther))}, so check your ${providerName} console for ${them ? 'them' : 'it'} and delete ${them ? "any that are this project's" : "it if it's this project's"}.`,
    );
    const billing = others.filter((o) => o.billing);
    if (billing.length > 0) {
      const sentence = `${listing(billing.map(theOther))} may be billing you while ${billing.length > 1 ? 'they exist' : 'it exists'}.`;
      sentences.push(sentence[0].toUpperCase() + sentence.slice(1));
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
    `Before it drops the record of that create, vibecarbon checks whether ${them ? 'those servers exist' : 'that server exists'}, and the check failed (${reason.replace(/\.$/, '')}).`,
    'The next deploy checks again.',
  ].join(' ');
}
