/**
 * NODE_OPTIONS=--import preload for the "malformed operator config" deploy
 * integration test (see ../deploy.test.ts).
 *
 * A malformed-but-present HETZNER_API_TOKEN still reaches a REAL network
 * call today: hetzner-guided-setup.js's getApiToken() verifies any non-empty
 * env token against the live Hetzner API before deploy ever resolves its
 * config. That verification treats an unreachable API as "proceed with the
 * token as given" (see validateHetznerToken's catch block) — the same
 * fallback a real network blip would hit — which is exactly the case this
 * preload simulates deterministically, without depending on this machine's
 * actual internet access or making a live request to api.hetzner.cloud with
 * a fake token.
 *
 * Deliberately throws a message that does NOT match fetch-retry.js's
 * isTransientNetworkError patterns (no "fetch failed" / ECONNRESET / etc.):
 * fetchServerTypes() retries transient failures 5x with backoff, and a
 * match here would cost the test ~15s for no reason — this is a permanent,
 * immediate failure, not a flaky one.
 */
const BLOCKED_HOSTS = ['api.hetzner.cloud'];
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (BLOCKED_HOSTS.some((host) => url.includes(host))) {
    throw new Error('vibecarbon test harness: outbound network blocked for this host');
  }
  return realFetch(input, init);
};
