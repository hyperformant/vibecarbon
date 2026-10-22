/**
 * Mask credential-shaped values in a line of command output before it is
 * quoted in an error or a status line: KEY/SECRET/TOKEN/PASSWORD assignments,
 * Bearer/Basic auth headers, and URL userinfo. A best-effort guard for output
 * that should hold no secrets anyway (docker pull, backup logs), not a
 * scanner.
 */

const SECRETISH = /([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi;
const BEARER = /\b(Bearer|Basic)\s+\S+/gi;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/**
 * @param {string} line
 * @returns {string} the line with credential-shaped values replaced by <redacted>
 */
export function redactCredentials(line) {
  return line
    .replace(URL_CREDS, '$1<redacted>@')
    .replace(BEARER, '$1 <redacted>')
    .replace(SECRETISH, '$1=<redacted>');
}
