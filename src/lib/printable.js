/**
 * Text a server sent, made safe to print. A server the CLI logs in to may be
 * hostile, and its output reaches the operator's terminal right before they
 * approve root actions: an escape sequence could move the cursor, erase a
 * line, forge a "healthy" one, set the clipboard (OSC 52) or hide a link
 * (OSC 8). So every C0 control character except newline and tab, DEL and
 * every C1 control character becomes U+FFFD. JSON output stays raw:
 * JSON.stringify escapes them already.
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
