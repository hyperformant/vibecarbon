/**
 * Reading the sentinel lines a remote script prints (`echo FENCE_WRITTEN`,
 * `echo "RESEED_REFUSED busy"`).
 *
 * A sentinel is a whole line of the command's stdout, never a substring of
 * some other text. Two reasons:
 *   - A failed command's `error.message` is `Command failed: <argv>\n<stderr>`
 *     (src/lib/command.js), and the argv carries the script text, so the
 *     literal `echo 'X_REFUSED ...'` inside it matches any unanchored search.
 *     Every failed exec (an ssh drop, an exec killed with its container) would
 *     then read as the script's own refusal. Only `stdout` holds what the
 *     script printed.
 *   - Output merged with stderr, or a shell trace, carries the script's lines
 *     (`+ echo X_DONE`); only an exact line is the sentinel itself.
 *
 * Every sentinel check in src/ goes through here or a `^...` regex with the
 * `m` flag; tests/unit/lib/remote-sentinel-census.test.ts enforces it.
 */

/**
 * The output's lines, each trimmed (a CRLF or indent never hides a sentinel).
 * `false`/null/undefined (sshRunScript's and ignoreError's "no output") read
 * as no lines.
 *
 * @param {unknown} output
 * @returns {string[]}
 */
export function outputLines(output) {
  if (output === false || output == null) return [];
  return String(output)
    .split('\n')
    .map((line) => line.trim());
}

/**
 * Does the output hold `token` as a whole line?
 *
 * @param {unknown} output a command's stdout
 * @param {string} token
 * @returns {boolean}
 */
export function hasSentinelLine(output, token) {
  return outputLines(output).includes(token);
}

/**
 * The text after `token ` on the first line that starts with it ('' for the
 * bare token line), or null when no line carries the token.
 *
 * @param {unknown} output a command's stdout
 * @param {string} token
 * @returns {string|null}
 */
export function sentinelLinePayload(output, token) {
  for (const line of outputLines(output)) {
    if (line === token) return '';
    if (line.startsWith(`${token} `)) return line.slice(token.length + 1).trim();
  }
  return null;
}

/**
 * A refusal a remote script printed before exiting with `status`: the payload
 * of its `token` line, read from the failed command's STDOUT only (never its
 * message, which quotes the script), and only when the exit status is the
 * refusal's own (a numeric status that differs is some other failure). null
 * means "not this refusal": the caller treats it as any other failure.
 *
 * @param {unknown} error a rejected command (src/lib/command.js shape)
 * @param {string} token
 * @param {{ status: number }} o the exit status the script refuses with
 * @returns {string|null}
 */
export function refusalFromError(error, token, { status }) {
  const failed = /** @type {{status?: unknown, stdout?: unknown} | null | undefined} */ (error);
  if (typeof failed?.status === 'number' && failed.status !== status) return null;
  return sentinelLinePayload(failed?.stdout, token);
}
