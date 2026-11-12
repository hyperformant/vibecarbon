/**
 * The preview a compose server's one-time seal up runs first (PR 2 final
 * review C1(b), ruling R36). Before the seal, a warm compose deploy never ran
 * an up at all: the recorded server and everything around it were left as
 * they were. The seal brings an up to every existing server once, so it may
 * not change anything live along the way:
 *
 *   - nothing on the server: a replace or delete takes the database on it
 *     along, a create (the state lost the recorded server) moves the app off
 *     that database, and an in-place update such as a resize stops the server;
 *   - no replace or delete of any other resource: a Scaleway IP replaced gives
 *     the server a new public address, which breaks DNS, and a firewall
 *     replaced leaves the server open while the old one is gone.
 *
 * Creates and in-place updates of the other resources (a firewall rule, an
 * SSH key's label) may apply. So upStack, asked with `refuseLiveChanges`,
 * previews after its refresh and stops before the up when the plan makes any
 * of those changes (refuseLiveChanges in iac/index.js); the compose deploy
 * then skips the seal and goes on as it did before (effects/index.js
 * provisionServer).
 *
 * converge-cluster.js runs the same kind of preview for a k8s master.
 */

/**
 * What a step does, by its op. Pulumi reports one replacement as `replace`,
 * `create-replacement` and `delete-replaced`; `delete` is a resource the
 * program no longer declares, `create` one the state doesn't hold.
 */
const ACTIONS = Object.freeze({
  update: 'update',
  replace: 'replace',
  'create-replacement': 'replace',
  'delete-replaced': 'replace',
  delete: 'delete',
  create: 'create',
});

/** The actions refused on any resource. */
const REFUSED_ANYWHERE = Object.freeze(new Set(['replace', 'delete']));

/** The ops that leave a server as it is: everything else is a change to it. */
const SERVER_KEEPS = Object.freeze(new Set(['same', 'read', 'refresh']));

/** The URN's type token (`urn:pulumi:<stack>::<project>::<parent$>type::name`). */
const urnType = (urn) =>
  String(urn ?? '')
    .split('::')[2]
    ?.split('$')
    .pop() ?? '';

/** The resource's own name: the input its provider names it by, else its Pulumi name. */
function nameOf(meta, nameInput) {
  const urn = String(meta.urn ?? '');
  for (const inputs of [meta.old?.inputs, meta.new?.inputs]) {
    for (const key of nameInput ? [nameInput] : ['name', 'label']) {
      const value = inputs?.[key];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return urn.split('::').pop() || urn;
}

/**
 * The live change an engine event's step would make, or null when the seal
 * may apply it.
 *
 * @param {object} event - an automation API engine event
 * @param {Readonly<Record<string, { noun: string, nameInput: string }>>} types - SERVER_RESOURCE_TYPES
 * @returns {{ op: string, action: string, urn: string, type: string, kind: string, name: string, server: boolean }|null}
 *   action: 'update', 'replace', 'delete', 'create' (or the op itself for any
 *   other change to a server); kind: the type's last segment (`Droplet`, `Ip`)
 */
export function liveChangeOf(event, types) {
  const meta = event?.resourcePreEvent?.metadata;
  if (!meta?.op) return null;
  const type = meta.type || urnType(meta.urn);
  // Pulumi's own bookkeeping: the stack and the provider plugins hold
  // nothing in the cloud.
  if (type === 'pulumi:pulumi:Stack' || type.startsWith('pulumi:providers:')) return null;
  const server = Object.hasOwn(types, type);
  const action = Object.hasOwn(ACTIONS, meta.op) ? ACTIONS[meta.op] : meta.op;
  if (server ? SERVER_KEEPS.has(meta.op) : !REFUSED_ANYWHERE.has(action)) return null;
  return {
    op: meta.op,
    action,
    urn: String(meta.urn ?? ''),
    type,
    kind: type.split(':').pop() || type,
    name: nameOf(meta, server ? types[type].nameInput : null),
    server,
  };
}

/**
 * The changes, one per resource and action (a replacement's three steps are
 * one), as the user reads them: `Droplet myapp-prod (update)`.
 *
 * @param {Array<{ action: string, urn: string, kind: string, name: string }>} changes
 * @returns {string[]}
 */
export function describeLiveChanges(changes) {
  const seen = new Set();
  const out = [];
  for (const change of changes) {
    const key = `${change.urn}|${change.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${change.kind} ${change.name} (${change.action})`);
  }
  return out;
}

/** The plan for a seal up would change something live: the up never ran. */
export class LiveChangeRefusedError extends Error {
  /**
   * @param {string} stackName
   * @param {Array<{ op: string, action: string, urn: string, kind: string, name: string }>} changes
   */
  constructor(stackName, changes) {
    super(
      `The up for ${stackName} would change ${describeLiveChanges(changes).join(', ')}, ` +
        `so it didn't run (steps: ${changes.map((c) => `${c.op} ${c.urn}`).join(', ')})`,
    );
    this.name = 'LiveChangeRefusedError';
    this.stackName = stackName;
    this.changes = changes;
  }
}
