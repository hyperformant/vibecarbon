/**
 * A DigitalOcean droplet size that went out of stock between the catalog check
 * and the create gets one readable message instead of a raw 422.
 *
 * Evidence for the wording: a real k8s-ha deploy log (d4, 2026-11-04, a droplet
 * named "db") carries the provider's answer verbatim:
 *   Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 422
 *   (request "...") Size is not available in this region.
 * The same `message` is what the REST API returns in its `{id, message}` body,
 * so the Pulumi path and the direct createServer path share one signature.
 *
 * The catalog filters `available !== false` up front, so this usually means a
 * stock-out after that check. DO's sentence does not say whether the size is
 * out of stock or not sold in the region, so the message says both are
 * possible. It is a definite answer from DO, so there is no retry: the message
 * says what to do instead. Unrelated 422s ("already in use",
 * "overlaps with another VPC", ...) do not match and pass through untouched.
 */

/** DO's 422 message for a size it cannot place in the region right now. */
export const SIZE_UNAVAILABLE_MESSAGE = /\bsize is not available in this region\b/i;

/** The droplet-create 422 as the bridged Terraform provider words it. */
const PULUMI_SIGNATURE =
  /Error creating droplet: POST \S*\/v2\/droplets: 422\b[^\n]*Size is not available in this region/i;

/** `digitalocean:index:Droplet (db):` in the Diagnostics block. */
const DIAGNOSTIC_DROPLET = /digitalocean:index:Droplet \(([^)\n]+)\):/g;

/**
 * Plain-language message: size and region named, no retry, what to do next.
 *
 * @param {object} info
 * @param {string} [info.size]
 * @param {string} [info.region]
 * @param {string} [info.name] droplet name or Pulumi resource name
 */
export function describeSizeUnavailable({ size, region, name } = {}) {
  const what = size ? `the droplet size "${size}"` : 'the droplet size you picked';
  const where = region ? ` in ${region}` : ' in that region';
  const which = name ? ` (needed for "${name}")` : '';
  return (
    `DigitalOcean could not create ${what}${where}${which}: ` +
    'it answered that the size is not available in the region. That can mean the size is out of ' +
    'stock or that the region does not sell it, and DigitalOcean does not say which. ' +
    `Pick another size or another region${region ? ` (other than ${region})` : ''}, or try ` +
    'again later. The deploy did not retry, because DigitalOcean gave a definite answer.'
  );
}

/**
 * Remembers the size and region each droplet was asked for, from the engine's
 * resource-pre events. A create that fails is never written to state, so the
 * checkpoint cannot supply them. Instrumentation only: never throws.
 */
export function createDropletPlanRecorder() {
  /** @type {Map<string, {size?: string, region?: string}>} keyed by Pulumi resource name */
  const plans = new Map();
  return {
    plans,
    onEvent(event) {
      try {
        const pre = event?.resourcePreEvent?.metadata;
        if (!pre?.urn || !String(pre.type).endsWith('digitalocean:index/droplet:Droplet')) return;
        const inputs = pre.new?.inputs ?? {};
        const name = String(pre.urn).split('::').at(-1);
        plans.set(name, {
          size: typeof inputs.size === 'string' ? inputs.size : undefined,
          region: typeof inputs.region === 'string' ? inputs.region : undefined,
        });
      } catch {
        /* recording must never fail a deploy */
      }
    },
  };
}

/**
 * Turn a failed `pulumi up` into the out-of-stock error, or null for any other
 * failure.
 *
 * @param {unknown} err original automation API error (kept as `cause`)
 * @param {object} [opts]
 * @param {Map<string, {size?: string, region?: string}>} [opts.plans]
 */
export function sizeUnavailableError(err, { plans = new Map() } = {}) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!PULUMI_SIGNATURE.test(message)) return null;
  const names = [...message.matchAll(DIAGNOSTIC_DROPLET)].map((m) => m[1]);
  const name = names.find((n) => plans.has(n)) ?? names[0];
  const plan = (name && plans.get(name)) || {};
  const out = new Error(describeSizeUnavailable({ ...plan, name }));
  out.name = 'SizeUnavailableError';
  out.cause = err;
  return out;
}
