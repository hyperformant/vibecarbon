/**
 * The scenario's compute token, and the one place a Hetzner-shaped child env
 * is allowed to be built from it.
 *
 * `runLifecycle` receives ONE provider-neutral `computeToken`: the token of
 * the scenario's own compute provider, resolved by the runner from the
 * provider registry. Before this module the lifecycle took a `hetznerToken`
 * for every scenario, so a DigitalOcean run handed the Hetzner token to the
 * DO DNS API (401 on every dns_flip_verified) and to the metrics collector's
 * Hetzner server listing. Rule: one provider's token never reaches another
 * provider's API.
 */

/**
 * `HCLOUD_TOKEN` is the Hetzner CLI/SDK variable, so it is set only for a
 * Hetzner scenario. Every other provider's deploy children resolve their own
 * credential from the project's .env.local (B8-3: provider runs prove the
 * customer path), so they get an empty env here, never a borrowed token.
 */
export function hcloudChildEnv(provider: string, computeToken: string): Record<string, string> {
  return provider === 'hetzner' ? { HCLOUD_TOKEN: computeToken } : {};
}
