/**
 * Tag decoding for the providers that tag resources with plain strings
 * rather than key/value labels: DigitalOcean, Linode, Vultr and Scaleway. A
 * label `key: value` travels as the tag `key:value`, encoded by each
 * provider's own `encodeLabel` (Linode's also caps the length with a hash
 * suffix); this turns such tags back into labels. Each provider module
 * re-exports it, so importers keep reading it from the provider.
 */

/**
 * The one key this codebase tags resources with whose canonical (pre-encode)
 * form contains a character `encodeLabel` mangles — `/` becomes `-`, so
 * `cluster-autoscaler/node` round-trips through the wire as
 * `cluster-autoscaler-node`. `encodeLabel`'s mangling is lossy IN GENERAL
 * (any `-` on the wire is ambiguous between "was always a dash" and "was
 * some other disallowed character"), but within this codebase's known,
 * fixed tag-key set (see serverLabels/volumeLabels' consumers — destroy.js's
 * cleanup* policy functions and carbon-autoscaler's node-group selector) no
 * OTHER key is spelled `cluster-autoscaler-node` before encoding, so
 * un-mangling this one prefix back to its slash form is unambiguous here. A
 * future key that introduces its own `/` (or any other mangled character)
 * needs its own entry, or decodeLabels silently returns the wire-mangled key
 * instead of the original.
 * @type {Object<string,string>}
 */
const KNOWN_MANGLED_LABEL_KEYS = { 'cluster-autoscaler-node': 'cluster-autoscaler/node' };

/**
 * Decode a tag array back into a flat label map — the inverse of a
 * provider's encodeLabels for this codebase's known key set (see
 * KNOWN_MANGLED_LABEL_KEYS's doc for the one collision this does NOT attempt
 * to resolve generically). Splits each tag on its FIRST `:` — safe because
 * every value this codebase encodes (cluster/environment/project names,
 * `vibecarbon`, `static`, `worker-pool`, ...) is itself colon-free. Tags
 * that don't contain `:` (e.g. a plain tag added in a provider's console)
 * are skipped rather than guessed at.
 * @param {string[]|null} [tags]
 * @returns {Object<string,string>}
 */
export function decodeLabels(tags = []) {
  const out = {};
  for (const tag of tags || []) {
    const sep = tag.indexOf(':');
    if (sep === -1) continue;
    const wireKey = tag.slice(0, sep);
    out[KNOWN_MANGLED_LABEL_KEYS[wireKey] ?? wireKey] = tag.slice(sep + 1);
  }
  return out;
}
