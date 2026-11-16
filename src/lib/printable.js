/**
 * Text a server sent, made safe to print. A server the CLI logs in to may be
 * hostile, and its output reaches the operator's terminal right before they
 * approve root actions: an escape sequence could move the cursor, erase a
 * line, forge a "healthy" one, set the clipboard (OSC 52) or hide a link
 * (OSC 8). So every C0 control character except newline and tab, DEL and
 * every C1 control character becomes U+FFFD.
 *
 * Where it applies decides what `-json` shows. Text a builder wrote into a
 * run's outcome (stepFailedError, didNotError, installHint, SEEN.*) and
 * describeSshError's line were filtered when they were made, so they are
 * filtered in the JSON too. Values the JSON carries as they came (node and
 * server names, package names, and a skipped reason such as the text of an
 * `@@error` line) stay raw there: JSON.stringify escapes control characters
 * itself. The terminal lines built from them filter them as they print.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function printable(value) {
  return String(value).replace(UNPRINTABLE, '�');
}
