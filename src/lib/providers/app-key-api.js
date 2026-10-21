/**
 * Small pieces the `mint` providers (Linode, DigitalOcean) share for minting
 * an environment's app storage key over their APIs (security plan R2).
 */

/**
 * The key's label: names the bucket it was minted for, so an operator can
 * tell vibecarbon's app keys apart in the console. Cut to the provider's
 * label limit.
 * @param {string} bucket
 * @param {number} max
 * @returns {string}
 */
export function appKeyLabel(bucket, max) {
  return `vc-app-${bucket}`.slice(0, max);
}

/**
 * The one line a refused mint fails the deploy with. A 401/403 names the
 * token scope the mint needs; there is never a fallback to the infra key.
 * @param {string} providerName
 * @param {number} status
 * @param {string} scopeHint
 * @returns {Error}
 */
export function appKeyMintError(providerName, status, scopeHint) {
  const why =
    status === 401 || status === 403
      ? `the API token needs ${scopeHint}`
      : 'try the deploy again once the provider API answers';
  const err = new Error(
    `${providerName} refused to mint the app storage key (HTTP ${status}): ${why}. The app never falls back to the account-wide key.`,
  );
  err.name = 'AppKeyMintError';
  return err;
}

/**
 * A response body as JSON, or {} when it has none.
 * @param {Response} res
 * @returns {Promise<any>}
 */
export async function readJson(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
