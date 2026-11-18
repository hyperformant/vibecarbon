/**
 * ASCII-only user data for the two providers whose user-data path cannot be
 * trusted with other bytes: DigitalOcean, whose pipeline double-encodes them
 * (the RCA is in iac/programs/digitalocean-compose.js), and Scaleway, whose
 * user data crosses the wire as plain text with no base64 leg (see
 * ScalewayProvider). The map and the walk are shared; what an unmapped
 * character becomes is each caller's: '?' on DigitalOcean, the character
 * itself on Scaleway, where assertAsciiCloudInit then refuses it loudly.
 */

/** Known typography in the shared cloud-init template, and its ASCII. */
const ASCII_TRANSLITERATION_MAP = {
  '—': '--', // em dash
  '–': '-', // en dash
  '‘': "'", // left single quote
  '’': "'", // right single quote
  '“': '"', // left double quote
  '”': '"', // right double quote
  '…': '...', // ellipsis
};

/**
 * Replace each non-ASCII character with its ASCII_TRANSLITERATION_MAP entry,
 * or with `unmapped(ch)` when the map has none. ASCII passes through.
 * @param {string} input
 * @param {(ch: string) => string} unmapped
 * @returns {string}
 */
export function transliterateWith(input, unmapped) {
  let out = '';
  for (const ch of input) {
    if (/** @type {number} */ (ch.codePointAt(0)) <= 0x7f) {
      out += ch;
      continue;
    }
    out += ASCII_TRANSLITERATION_MAP[ch] ?? unmapped(ch);
  }
  return out;
}
