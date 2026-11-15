/**
 * Character caps for failure-bundle sections.
 *
 * Every section's command already bounds its own output by lines (`tail -N`,
 * `--tail=N`, `head -N`), and that line budget is what decides how much
 * survives. The character cap is only a guard against runaway output, so it
 * sits well above any section's line budget, and when it does cut it keeps
 * the NEWEST lines: for logs and event tails that is where the failure is.
 * A section that wants its earliest lines picks them inside its own command
 * (`head -N`) before the guard ever applies.
 *
 * GitHub run 43757126064 is why: the k8s "traefik and app logs" section asked
 * four pods for 60 lines each, and a 4,000-character head cut kept the first
 * pod's four oldest lines, which hid the 404s that would have named the cause.
 */

/** Runaway guard for one failure-bundle section, in characters. */
export const DIAGNOSTIC_SECTION_MAX_CHARS = 128_000;

/**
 * Cap at maxChars, keeping the tail (the newest lines) from a line boundary:
 * the partial line the cut leaves first is dropped. Callers that redact pass
 * redacted text only: a cut made before redaction can split a token so that
 * its surviving half no longer matches any pattern.
 */
export function capTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const kept = text.slice(cut);
  const onBoundary = text[cut - 1] === '\n';
  const nl = kept.indexOf('\n');
  const body = onBoundary ? kept : nl === -1 ? '' : kept.slice(nl + 1);
  return `(truncated to the last ${maxChars} chars, from a line boundary)\n${body}`;
}
