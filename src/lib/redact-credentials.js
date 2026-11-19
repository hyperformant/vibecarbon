/**
 * Mask credential-shaped values in a line of command output before it is
 * quoted in an error or a status line: KEY/SECRET/TOKEN/PASSWORD assignments,
 * Bearer/Basic auth headers, and URL userinfo. A best-effort guard for output
 * that should hold no secrets anyway (docker pull, backup logs), not a
 * scanner.
 */

// Each pattern starts a match only where a match can begin, so a long run is
// scanned once, not again from every position inside it: the earlier forms
// took seconds on a 50,000-character line (tests/unit/lib/redact-credentials).
//   SECRETISH: a whole word that holds a keyword (the lookbehind pins the
//     start of the word; the lookahead checks the keyword without consuming).
//   URL_CREDS: the userinfo right after a scheme, found from the `://` back.
const SECRETISH =
  /(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS))([A-Za-z0-9_]+)\s*[=:]\s*\S+/gi;
const BEARER = /\b(Bearer|Basic)\s+\S+/gi;
const URL_CREDS = /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/**
 * @param {string} line
 * @returns {string} the line with credential-shaped values replaced by <redacted>
 */
export function redactCredentials(line) {
  return line
    .replace(URL_CREDS, '<redacted>@')
    .replace(BEARER, '$1 <redacted>')
    .replace(SECRETISH, '$1=<redacted>');
}
