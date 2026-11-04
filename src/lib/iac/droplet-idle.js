/**
 * Wait until a DigitalOcean droplet has no action in progress.
 *
 * A droplet takes one action at a time. The provider's droplet Create returns
 * as soon as the droplet's status reads `active`, which DigitalOcean sets
 * before the droplet's own `create` action completes. A resource that makes
 * DigitalOcean run another droplet action (reserved IP assign, volume attach,
 * snapshot, resize) can therefore POST while `create` is still running and
 * get `422 Droplet already has a pending event` (k8s-ha restore deploy,
 * 2026-11-04). Gating the resource's `dropletId` on this function makes the
 * ordering a condition, not a retry.
 *
 * Polls GET /v2/droplets/{id}/actions until no action is `in-progress`.
 * Any non-2xx reply or network error throws at once: that is a hard failure,
 * not a reason to keep polling. The token is never logged or put in a message.
 *
 * @param {object} opts
 * @param {string} opts.token                DigitalOcean API token.
 * @param {string|number} opts.dropletId
 * @param {number} [opts.timeoutMs=180000]   Deadline for the whole wait.
 * @param {number} [opts.intervalMs=3000]    Pause between polls.
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<void>}
 */
export async function waitForDropletIdle({
  token,
  dropletId,
  timeoutMs = 180_000,
  intervalMs = 3_000,
  fetchImpl = fetch,
}) {
  const url = `https://api.digitalocean.com/v2/droplets/${dropletId}/actions?per_page=20`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(
        `DigitalOcean droplet ${dropletId} action lookup failed (HTTP ${res.status})`,
      );
    }
    const body = await res.json();
    const busy = (body.actions ?? []).find((a) => a.status === 'in-progress');
    if (!busy) return;

    if (Date.now() + intervalMs > deadline) {
      throw new Error(
        `DigitalOcean droplet ${dropletId} still has a ${busy.type} action (id ${busy.id}) in progress after ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
