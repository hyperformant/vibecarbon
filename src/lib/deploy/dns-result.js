/**
 * The deploy-side consumer of a DNS backend's setupSimple / setupHA result.
 *
 * Those functions never throw: a refused record write comes back as
 * `{ success: false, error }`. A caller that ignores the result prints "DNS A
 * record set" over a write the provider refused, and the deploy runs on to a
 * certificate and health probe that can never pass. Every caller goes through
 * here so a refused write fails the deploy with a one-line cause. A
 * health-check-only refusal is not a failure: the backend warns and still
 * reports success.
 */

/**
 * @param {{ success?: boolean, error?: string }|null|undefined} result
 * @param {string} what - what was being set up, e.g. "DNS A record for app.example.com"
 * @returns {object} the result, when it succeeded
 * @throws {Error} one line naming what failed and why
 */
export function requireDnsSetup(result, what) {
  if (result?.success === false) {
    throw new Error(`${what} was not set: ${result.error || 'the DNS provider refused the write'}`);
  }
  return result;
}
