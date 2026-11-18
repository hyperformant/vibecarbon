/** How far a webhook's signed timestamp may be from now: 5 minutes, as Stripe's SDK allows. */
const TOLERANCE_SEC = 5 * 60;

/**
 * SECURITY: reject a stale (or far-future) webhook event to blunt replay
 * attacks. A captured, validly signed payload could otherwise be resent
 * forever to re-assert subscription state. `timestamp` is the signed Unix time
 * in seconds (Paddle's `ts`, the Standard Webhooks `webhook-timestamp` Polar
 * sends); `provider` names the provider in the error. Call it after the
 * signature check, so the timestamp is one the provider signed.
 */
export function assertFreshWebhookTimestamp(timestamp: string, provider: string): void {
  const timestampSec = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSec)) {
    throw new Error(`Invalid ${provider} webhook timestamp`);
  }
  const ageSec = Math.abs(Date.now() / 1000 - timestampSec);
  if (ageSec > TOLERANCE_SEC) {
    throw new Error(`${provider} webhook timestamp outside tolerance`);
  }
}
