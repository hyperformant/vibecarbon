/**
 * One readable line from a raw command-error dump.
 *
 * The Pulumi automation API's CommandResult envelope reads
 * `code: N\n stdout: …\n stderr: …\n err?: …`, so printing an error's message
 * as-is puts that whole dump on the terminal (the excitingai destroy,
 * 2026-10-16, showed it in the spinner line and again in the Stats box),
 * while taking its first line yields the literal `code: -2`. Both hide the
 * one line that matters: the first top-level `error:` line.
 */

const ENVELOPE_HEAD_RE = /code:\s*-?\d+\s*$/i;

/**
 * True when `text` carries the automation API's raw envelope.
 * @param {string} text
 */
export function isCommandEnvelope(text) {
  const lines = String(text ?? '').split('\n');
  return (
    ENVELOPE_HEAD_RE.test(lines[0] ?? '') && lines.some((l) => /^\s*(stdout|stderr):/i.test(l))
  );
}

/**
 * The informative line of a command error: the first `error:` line, then a
 * panic banner, then the first line, and never a bare `code: N` header. A
 * prefix the caller put in front of the envelope (`Failed to remove …: code:
 * -2`) is kept in front of the line that replaces it.
 * @param {string} text
 * @returns {string}
 */
export function summarizeCommandError(text) {
  const msg = String(text ?? '');
  const lines = msg.split('\n');
  const head = lines[0] ?? '';
  const prefix = ENVELOPE_HEAD_RE.test(head) ? head.replace(ENVELOPE_HEAD_RE, '') : null;
  const pick =
    lines.find((l) => /^\s*error:/i.test(l)) ??
    lines.find((l) => /^\s*panic:/i.test(l)) ??
    (prefix === null ? head : (lines.find((l) => /^\s*stderr:\s*\S/i.test(l)) ?? null));
  if (pick === null) return lines.filter(Boolean).join(' ').trim() || msg.trim();
  return `${prefix ?? ''}${pick.trim()}`.trim();
}

/**
 * What a spinner line or a step label should show for `message`: unchanged
 * unless it is a raw command envelope, in which case the one line that
 * matters. The caller keeps the full text for the log.
 * @param {string} message
 * @returns {string}
 */
export function displayLine(message) {
  if (typeof message !== 'string' || !isCommandEnvelope(message)) return message;
  return summarizeCommandError(message);
}
