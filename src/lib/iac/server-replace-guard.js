/**
 * The preview a compose server's one-time seal up runs first (PR 2 final
 * review C1(b)). Before the seal, a warm compose deploy never ran an up at
 * all: the recorded server was left as it was. The seal brings an up to every
 * existing server once, and an up whose plan replaces or deletes the server
 * takes the database on it along, as does one that creates a new server
 * because the state lost track of the recorded one. So upStack, asked with
 * `refuseServerReplace`, previews after its refresh and stops before the up
 * when the plan would replace, delete or create a server (refuseServerRemoval
 * in iac/index.js); the compose deploy then skips the seal and goes on as it
 * did before (effects/index.js provisionServer).
 *
 * converge-cluster.js runs the same kind of preview for a k8s master.
 */

/**
 * The step ops that would leave the recorded server behind, by what they do
 * to it. Pulumi reports one replacement as `replace`, `create-replacement` and
 * `delete-replaced`, so any one of them marks it; `delete` is a server the
 * program no longer declares, and `create` a server the state doesn't hold.
 */
export const SERVER_REMOVING_OPS = Object.freeze({
  replace: 'replace',
  'create-replacement': 'replace',
  'delete-replaced': 'replace',
  delete: 'delete',
  create: 'create',
});

/** The resource type a URN names (`urn:pulumi:<stack>::<project>::<type>::<name>`). */
const urnType = (urn) => String(urn ?? '').split('::')[2] ?? '';

/**
 * The server an engine event's step would replace, delete or create, or null.
 *
 * @param {object} event - an automation API engine event
 * @param {Readonly<Record<string, { noun: string, nameInput: string }>>} types - SERVER_RESOURCE_TYPES
 * @returns {{ op: string, action: string, urn: string, noun: string, name: string }|null}
 *   action: 'replace', 'delete' or 'create'
 */
export function serverRemovalOf(event, types) {
  const meta = event?.resourcePreEvent?.metadata;
  const action =
    meta && Object.hasOwn(SERVER_REMOVING_OPS, meta.op) && SERVER_REMOVING_OPS[meta.op];
  if (!action) return null;
  const type = meta.type || urnType(meta.urn);
  const spec = Object.hasOwn(types, type) ? types[type] : null;
  if (!spec) return null;
  const urn = String(meta.urn ?? '');
  const name =
    meta.old?.inputs?.[spec.nameInput] ??
    meta.new?.inputs?.[spec.nameInput] ??
    urn.split('::').pop() ??
    urn;
  return { op: meta.op, action, urn, noun: spec.noun, name: String(name) };
}

/** The plan for a seal up would replace, delete or create a server: the up never ran. */
export class ServerReplaceRefusedError extends Error {
  /**
   * @param {string} stackName
   * @param {Array<{ op: string, action: string, urn: string, noun: string, name: string }>} removals
   */
  constructor(stackName, removals) {
    const first = removals[0];
    super(
      `The up for ${stackName} would ${first.action} ` +
        `${first.noun} ${first.name}, so it didn't run (${removals
          .map((r) => `${r.op} ${r.urn}`)
          .join(', ')})`,
    );
    this.name = 'ServerReplaceRefusedError';
    this.stackName = stackName;
    this.removals = removals;
  }
}
