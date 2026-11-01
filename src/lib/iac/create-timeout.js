/**
 * Bounded server creates, and the one-line error when a provider stalls one.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-20 a compose-ha restore redeploy asked Hetzner for server
 * `…-e2-standby` in hel1. Hetzner left the `create_server` and `start_server`
 * actions at progress 0 for more than 70 minutes, and `pulumi up --stack
 * e2-standby` waited the whole time with no output. Nothing was wrong with the
 * project: one provider host never got around to the work.
 *
 * Every provider program sets `customTimeouts` from here on each server-class
 * resource (tests/unit/iac/server-create-timeouts-census.test.ts holds that
 * line). The bridged Terraform providers turn it into the context deadline of
 * the create call: each of these resources declares a `Timeouts` block, so the
 * value is honoured rather than ignored with a warning. Without it the provider
 * default applies, and the defaults are far past anything a person would sit
 * through (bridged versions: hcloud v1.70.0 90m, DigitalOcean 60m, Vultr 60m,
 * Scaleway 20m, Linode v4.7.0 15m).
 *
 * The other resource classes the programs create (firewalls, SSH keys,
 * networks, subnets, floating/reserved IPs, placement groups, VPCs, tags) need
 * nothing here: they declare no `Timeouts`, so terraform-plugin-sdk/v2 runs
 * their create under its 20 minute default context, and the deploy logs show
 * every one of them finishing in 11s or less.
 *
 * THE BOUND, FROM EVIDENCE
 * ------------------------
 * Per-resource create times from the `created (Ns)` lines in
 * ~/.vibecarbon/logs: hcloud servers 30-68s (10 creates), every other class
 * 1-11s. Whole-stack `pulumi up` times from tests/results/e2e.db
 * (perf_substep `*.iac.upStack`, ~230 rows across Hetzner, DigitalOcean and
 * Vultr) top out at 289s for a stack that creates several servers, apart from
 * stuck creates. The stuck ones are the class this bound exists for: an 18
 * minute hel1 standby (e4, 2026-08-28) and tonight's 70+ minutes. 15 minutes
 * is about 13x the slowest healthy server create and 3x the slowest healthy
 * stack, so a healthy deploy never reaches it, and a stuck one fails in a
 * quarter of an hour instead of never.
 */

/** Minutes a server-class create may take before the provider gives up on it. */
export const SERVER_CREATE_TIMEOUT_MINUTES = 15;

/** Pulumi duration string for {@link SERVER_CREATE_TIMEOUT_MINUTES}. */
export const SERVER_CREATE_TIMEOUT = `${SERVER_CREATE_TIMEOUT_MINUTES}m`;

/**
 * The `customTimeouts` resource option for every server-class resource. Only
 * `create`: that is the operation the evidence shows stalling, and the hcloud
 * server resource declares a create timeout only.
 */
export const SERVER_CUSTOM_TIMEOUTS = Object.freeze({ create: SERVER_CREATE_TIMEOUT });

/**
 * Server-class Pulumi type tokens, with the noun the message uses and the
 * input that holds the resource's location.
 */
export const SERVER_RESOURCE_TYPES = Object.freeze({
  'hcloud:index/server:Server': {
    noun: 'server',
    locationInput: 'location',
    userDataInput: 'userData',
  },
  'digitalocean:index/droplet:Droplet': {
    noun: 'droplet',
    locationInput: 'region',
    userDataInput: 'userData',
  },
  'vultr:index/instance:Instance': {
    noun: 'instance',
    locationInput: 'region',
    userDataInput: 'userData',
  },
  'linode:index/instance:Instance': {
    noun: 'instance',
    locationInput: 'region',
    userDataInput: 'metadatas',
  },
  'scaleway:instance/server:Server': {
    noun: 'server',
    locationInput: 'zone',
    userDataInput: 'userData',
  },
});

/**
 * The resource options every server-class resource is created with: the
 * bounded create (SERVER_CUSTOM_TIMEOUTS) and `ignoreChanges` on its
 * user-data input. Every provider replaces a server whose user data changes,
 * and a compose server's database (a k8s db node's too) lives on its disk, so
 * an edit to a cloud-init file must reach new servers only, never replace an
 * existing one. tests/unit/iac/server-create-timeouts-census.test.ts runs
 * every program and fails on a server built without these.
 *
 * @param {keyof typeof SERVER_RESOURCE_TYPES} type the server's Pulumi type token
 * @param {object} [extra] other resource options (dependsOn, ...)
 */
export function serverResourceOptions(type, extra = {}) {
  const serverClass = SERVER_RESOURCE_TYPES[type];
  if (!serverClass) throw new Error(`serverResourceOptions: unknown server type ${type}`);
  return {
    ...extra,
    customTimeouts: SERVER_CUSTOM_TIMEOUTS,
    ignoreChanges: [...(extra.ignoreChanges ?? []), serverClass.userDataInput],
  };
}

/**
 * The options for a k8s WORKER: the bounded create, but no `ignoreChanges` on
 * its user data. A worker holds no data, and its user data carries its join
 * target (the k3s token, the master's private IP), so it must be rebuilt when
 * that changes rather than keep joining a master that is gone.
 *
 * @param {keyof typeof SERVER_RESOURCE_TYPES} type
 * @param {object} [extra]
 */
export function workerResourceOptions(type, extra = {}) {
  if (!SERVER_RESOURCE_TYPES[type]) {
    throw new Error(`workerResourceOptions: unknown server type ${type}`);
  }
  return { ...extra, customTimeouts: SERVER_CUSTOM_TIMEOUTS };
}

/** Provider display names and status pages, keyed by Pulumi package. */
const PROVIDER_PACKAGES = Object.freeze({
  hcloud: { label: 'Hetzner', statusUrl: 'https://status.hetzner.com' },
  digitalocean: { label: 'DigitalOcean', statusUrl: 'https://status.digitalocean.com' },
  vultr: { label: 'Vultr', statusUrl: 'https://status.vultr.com' },
  linode: { label: 'Linode', statusUrl: 'https://status.linode.com' },
  scaleway: { label: 'Scaleway', statusUrl: 'https://status.scaleway.com' },
});

/**
 * How a create deadline reads once it fires, per provider implementation:
 * hcloud-go's action wait and Linode return the context error; the SDKv2
 * StateChangeConf waiters (DigitalOcean, Vultr) say "timeout while waiting
 * for state"; scaleway-sdk-go's waiters say "timeout after 15m0s"; the gRPC
 * spelling covers a deadline that lands on the engine-provider call itself.
 * A Go HTTP client's own per-request timeout also says "context deadline
 * exceeded", but always followed by "(Client.Timeout", and is one request
 * failing, not the create stalling, so it is excluded.
 */
const TIMEOUT_SIGNATURE =
  /context deadline exceeded(?! \(Client\.Timeout)|code = DeadlineExceeded|timeout while waiting for (?:state|resource)|\btimeout after \d|timed out waiting for/i;

/** `* creating urn:pulumi:<stack>::<project>::<type>::<name>:` in Diagnostics. */
const CREATING_URN = /\bcreating (urn:pulumi:([^:\s]+)::([^:\s]+)::(\S+?)::([^\s:]+)):/g;

/**
 * The resources whose create failed on a deadline, from a failed `pulumi up`'s
 * error text. Empty when the failure is anything else.
 *
 * @param {string} message
 * @returns {Array<{urn: string, stack: string, type: string, logicalName: string, elapsedSeconds: number|null}>}
 */
export function parseCreateTimeouts(message) {
  const text = String(message ?? '');
  if (!TIMEOUT_SIGNATURE.test(text)) return [];
  const found = new Map();
  for (const m of text.matchAll(CREATING_URN)) {
    const [, urn, stack, , qualifiedType, logicalName] = m;
    if (found.has(urn)) continue;
    // A child resource's URN type is `parent$child`; the resource is the last.
    const type = qualifiedType.split('$').pop();
    found.set(urn, {
      urn,
      stack,
      type,
      logicalName,
      elapsedSeconds: elapsedFor(text, logicalName),
    });
  }
  return [...found.values()];
}

/** Longest `<name> creating (Ns)` progress figure for a resource, or null. */
function elapsedFor(text, logicalName) {
  const escaped = logicalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\s${escaped} (?:\\*\\*)?creating(?: failed\\*\\*)? \\((\\d+)s\\)`, 'g');
  let max = null;
  for (const m of text.matchAll(re)) max = Math.max(max ?? 0, Number(m[1]));
  return max;
}

/** `e2-standby` → `e2`: the HA stacks are `<env>-primary` / `<env>-standby`. */
export function environmentForStack(stackName) {
  return String(stackName ?? '').replace(/-(primary|standby)$/, '');
}

/** `1 minute`, never `1 minutes`. */
function minutes(n) {
  return n === 1 ? '1 minute' : `${n} minutes`;
}

/**
 * The one-line, second-person message for a stalled create.
 *
 * @param {object} info
 * @param {string} info.type - Pulumi type token
 * @param {string} info.logicalName - Pulumi resource name (fallback for the cloud name)
 * @param {string} [info.resourceName] - the name the provider shows
 * @param {string} [info.location]
 * @param {number|null} [info.elapsedSeconds]
 * @param {number} [info.others] - further resources that stalled in the same update
 * @returns {string}
 */
export function describeCreateTimeout({
  type,
  logicalName,
  resourceName,
  location,
  elapsedSeconds = null,
  others = 0,
}) {
  const pkg = String(type).split(':')[0];
  const provider = PROVIDER_PACKAGES[pkg] ?? { label: pkg, statusUrl: null };
  const serverClass = SERVER_RESOURCE_TYPES[type];
  const noun = serverClass?.noun ?? lastSegment(type);
  const shownName = resourceName || logicalName;
  const where = location ? ` in ${location}` : '';
  const waited = serverClass
    ? minutes(SERVER_CREATE_TIMEOUT_MINUTES)
    : elapsedSeconds
      ? minutes(Math.max(1, Math.round(elapsedSeconds / 60)))
      : 'its create deadline';
  const also = others > 0 ? ` (and ${others} more in the same update)` : '';
  const elsewhere = location
    ? `pick a location other than ${location}`
    : 'pick a different location';
  const status = provider.statusUrl
    ? `, and check ${provider.statusUrl} for an open incident`
    : `, and check ${provider.label}'s status page for an open incident`;
  return (
    `${provider.label} never finished creating ${noun} "${shownName}" (${type})${where}${also}, ` +
    `so the deploy stopped after ${waited} instead of waiting on it forever. ` +
    `A create that stalls like this is a slow or stuck host on ${provider.label}'s side, not ` +
    `something in your project. Delete that ${noun} in the ${provider.label} console and run the ` +
    'deploy again: the deploy notices it is gone and creates a fresh one, which usually lands on a ' +
    `healthy host. If it stalls again, ${elsewhere}${status}. ` +
    'The full Pulumi output is in the deploy log (~/.vibecarbon/logs).'
  );
}

function lastSegment(type) {
  const tail = String(type).split(':').pop() ?? String(type);
  return tail.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * Turn a failed `pulumi up` into the stalled-create error, or return null when
 * the failure is something else.
 *
 * `resources` is the stack's checkpoint (`exportStack().deployment.resources`)
 * read after the failure. The providers record the resource as soon as the
 * create call returns an id, before they wait on it, so a stalled resource is
 * in state with its inputs: that is where the provider-side name and the
 * location come from, and it is also why `vibecarbon destroy` and the next
 * deploy's refresh can see it.
 *
 * @param {unknown} err - the original automation API error (kept as `cause`)
 * @param {object} [opts]
 * @param {Array<{urn?: string, inputs?: Record<string, unknown>, outputs?: Record<string, unknown>}>} [opts.resources]
 * @returns {Error & {createTimeout?: object} | null}
 */
export function createTimeoutError(err, { resources = [] } = {}) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const stalled = parseCreateTimeouts(message);
  if (stalled.length === 0) return null;
  // Name a server-class resource first: that is the class with a bound of
  // ours, and the one the next steps are written for.
  const first = stalled.find((s) => SERVER_RESOURCE_TYPES[s.type]) ?? stalled[0];
  const row = resources.find((r) => r?.urn === first.urn);
  const props = { ...(row?.outputs ?? {}), ...(row?.inputs ?? {}) };
  const locationKey = SERVER_RESOURCE_TYPES[first.type]?.locationInput;
  const location = [locationKey, 'location', 'region', 'zone']
    .map((k) => (k ? props[k] : undefined))
    .find((v) => typeof v === 'string' && v.length > 0);
  const resourceName = typeof props.name === 'string' ? props.name : (props.label ?? undefined);
  const details = {
    ...first,
    resourceName,
    location,
    environment: environmentForStack(first.stack),
    others: stalled.length - 1,
  };
  const out = new Error(describeCreateTimeout(details));
  out.name = 'CreateTimeoutError';
  out.cause = err;
  out.createTimeout = { ...details, stalled };
  return out;
}
