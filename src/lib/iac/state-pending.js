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
 *   - a server is looked up by the name the program gave it (`nameInput`).
 *     When the provider lists no server by that name that the state doesn't
 *     track, the create made nothing that survived. One it does list is
 *     running untracked and billing, and the user deletes it in the console;
 *   - vibecarbon has no lookup for any other resource, so the user is told to
 *     check the console, and the deploy after the one that said so clears it.
 *     The ledger keeps what was reported (pendingReported), so "then deploy
 *     again" is what clears it.
 *
 * Never logs or prints an input value beyond a resource's name.
 */

/**
 * @typedef {{ urn: string, noun: string, name: string }} PendingServer
 * @typedef {{ urn: string, what: string, name: string }} PendingOther
 * @typedef {PendingServer & { id: string }} UntrackedServer
 */

/**
 * `deployment`'s pending operations, split into the server creates the
 * provider can be asked about and everything else.
 * @param {{ deployment?: { pending_operations?: Array<{ type?: string, resource?: { urn?: string, type?: string, inputs?: Record<string, unknown> } }> } }} deployment
 * @param {Readonly<Record<string, { noun: string, nameInput: string }>>} types - SERVER_RESOURCE_TYPES
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
    if (op?.type === 'creating' && serverClass && typeof name === 'string' && name) {
      servers.push({ urn, noun: serverClass.noun, name });
    } else {
      others.push({ urn, what: kindOf(resource.type), name: nameOf(resource, urn) });
    }
  }
  return { servers, others };
}

/** `hcloud:index/firewall:Firewall` → `firewall`, `ReservedIpAssignment` → `reserved ip assignment`. */
function kindOf(type) {
  const cls =
    String(type ?? '')
      .split(':')
      .pop() || 'resource';
  return cls.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

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
 * The servers a pending create may have left running: each one the provider
 * lists under a pending create's name whose id no server in the state has.
 * Rejects when the provider can't list every server (findServersByName's
 * strict mode): an empty answer then would drop the record of a server that
 * may exist.
 * @param {PendingServer[]} servers
 * @param {{ deployment?: { resources?: Array<{ type?: string, id?: unknown }> } }} deployment
 * @param {Readonly<Record<string, object>>} types - SERVER_RESOURCE_TYPES
 * @param {{ findServersByName: (name: string, options: { strict: boolean }) => Promise<Array<{ id: unknown }>> }} client
 * @returns {Promise<UntrackedServer[]>}
 */
export async function untrackedServers(servers, deployment, types, client) {
  const tracked = new Set(
    (deployment?.deployment?.resources ?? [])
      .filter((r) => r?.type in types && r.id != null && r.id !== '')
      .map((r) => bareId(r.id)),
  );
  /** @type {Map<string, UntrackedServer>} */
  const found = new Map();
  for (const server of servers) {
    for (const listed of await client.findServersByName(server.name, { strict: true })) {
      const id = bareId(listed.id);
      if (!tracked.has(id) && !found.has(id)) found.set(id, { ...server, id });
    }
  }
  return [...found.values()];
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

const opening = (stackName) =>
  `Your servers in ${stackName} are updated, but vibecarbon left their user data in plain text in the Pulumi state.`;

/**
 * What the user reads when unfinished creates may have left something in
 * their account: servers the provider lists untracked, and resources
 * vibecarbon can't look up. Each needs the console, then another deploy,
 * which clears the records and seals.
 * @param {string} stackName
 * @param {{ untracked: UntrackedServer[], others: PendingOther[], providerName: string }} found
 */
export function pendingCreatesBlock(stackName, { untracked, others, providerName }) {
  const items = [
    ...untracked.map((s) => `the ${s.noun} ${s.name}`),
    ...others.map((o) => `the ${o.what} ${o.name}`),
  ];
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
      `Nothing in vibecarbon can look up ${listing(others.map((o) => `the ${o.what} ${o.name}`))}, so check your ${providerName} console for ${them ? 'them' : 'it'} and delete ${them ? 'any that are' : "it if it's"} there.`,
    );
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
