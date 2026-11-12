/**
 * Seal the user data an existing server keeps as plain text in a stack's
 * state.
 *
 * The programs wrap every server's user data in `pulumi.secret` (and the k8s
 * programs their `k3sToken` export), so the state holds it encrypted with the
 * project's state passphrase. That reaches servers created from then on only.
 * Server user data sits in `ignoreChanges` (create-timeout.js
 * serverResourceOptions), so on a server that already exists the wrap is a
 * `same` step, and the engine keeps the inputs and outputs the state already
 * holds: plain text, the provider token and (k8s) the k3s join token among
 * them. Proven on Pulumi 3.259.0 with a file backend (Task 6 review,
 * 2026-11-11): after the wrapped `up` on an existing stack, the user data was
 * still plain in the checkpoint.
 *
 * So after every successful up, upStack exports the state, runs this over it,
 * and imports the result when it sealed anything (lib/iac/index.js
 * sealStackState says why after the up and not before). The `k3sToken` Stack
 * output is covered too, though an up of the current program already writes
 * it sealed.
 */

/**
 * The key and value Pulumi marks a secret with in a deployment
 * (`resource.SecretSig`; the Node SDK's rpc.specialSigKey and
 * rpc.specialSecretSig). `stack export --show-secrets` writes a secret as
 * `{ [SECRET_SIG_KEY]: SECRET_SIG, plaintext: <the value as JSON> }`, and
 * `stack import` encrypts that with the stack's passphrase.
 */
export const SECRET_SIG_KEY = '4dabf18193072939515e22adb298388d';
export const SECRET_SIG = '1b47061264138c4ac30d75fd1eb44270';

/** The Stack's own resource, whose `outputs` are the stack outputs. */
const STACK_TYPE = 'pulumi:pulumi:Stack';

/** The stack outputs that are sealed when found plain. */
const SECRET_STACK_OUTPUTS = ['k3sToken'];

/** @param {unknown} value */
function isSecret(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    /** @type {Record<string, unknown>} */ (value)[SECRET_SIG_KEY] === SECRET_SIG
  );
}

/**
 * `value` with every secret inside it opened, so one secret can wrap the
 * whole; null when one of them is ciphertext, which only the passphrase
 * opens.
 * @param {unknown} value
 * @returns {{ value: unknown } | null}
 */
function opened(value) {
  if (isSecret(value)) {
    const { plaintext } = /** @type {{ plaintext?: unknown }} */ (value);
    if (typeof plaintext !== 'string') return null;
    return opened(JSON.parse(plaintext));
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const inner = opened(item);
      if (!inner) return null;
      items.push(inner.value);
    }
    return { value: items };
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const inner = opened(item);
      if (!inner) return null;
      out[key] = inner.value;
    }
    return { value: out };
  }
  return { value };
}

/**
 * Seal `holder[key]` when it is there and not a secret already.
 * @param {Record<string, unknown> | undefined} holder
 * @param {string} key
 * @returns {boolean} whether it sealed it
 */
function seal(holder, key) {
  if (!holder || typeof holder !== 'object') return false;
  const value = holder[key];
  if (value === undefined || value === null || isSecret(value)) return false;
  const inner = opened(value);
  if (!inner) return false;
  holder[key] = { [SECRET_SIG_KEY]: SECRET_SIG, plaintext: JSON.stringify(inner.value) };
  return true;
}

/**
 * Wrap every plain user data value of a server resource (`inputs` and
 * `outputs`, under the field `types[type].userDataInput` names: a string on
 * Hetzner, DigitalOcean and Vultr, Linode's `metadatas` array, Scaleway's
 * `userData` map) and a plain `k3sToken` Stack output in Pulumi's secret
 * envelope. A value that is already a secret is left alone, so a second run
 * seals nothing; a value holding ciphertext is left alone too.
 *
 * Pure: returns a new deployment, the same content and `count` 0 when
 * nothing was plain.
 *
 * @param {{ deployment?: { resources?: object[] } }} state - exportStack's result, secrets shown
 * @param {Readonly<Record<string, { userDataInput: string }>>} types - server type token to its
 *   class (create-timeout.js SERVER_RESOURCE_TYPES)
 * @returns {{ deployment: object, count: number }} `count`: the values sealed
 */
export function sealServerUserData(state, types) {
  const next = structuredClone(state);
  let count = 0;
  for (const resource of next?.deployment?.resources ?? []) {
    const type = resource?.type;
    if (type === STACK_TYPE) {
      for (const key of SECRET_STACK_OUTPUTS) if (seal(resource.outputs, key)) count++;
      continue;
    }
    if (!Object.hasOwn(types, type)) continue;
    const field = types[type].userDataInput;
    for (const side of ['inputs', 'outputs']) if (seal(resource[side], field)) count++;
  }
  return { deployment: next, count };
}
