/**
 * Single-cluster k8s's domain records (apex + wildcard, the provider's
 * setupSimple): one target, the cluster's ingress IP (clusterIngressIp: its
 * floating IP on Hetzner and Linode, its master's own address on
 * DigitalOcean), gated on {domain, provider, ip} by the `k8s-dns-update`
 * state step.
 *
 * Single k8s only. A k8s-ha deploy never builds this writer: its records have
 * one writer, the plan's update-dns step (effects/k8s-ha.js, the provider's
 * setupHA at the serving primary), and a setupSimple write after it would
 * replace what setupHA wrote (TTL, health checks) while the first certificate
 * may still be issuing.
 *
 * The write starts from deployK3s's onInfraReady hook, the moment the
 * cluster's addresses exist, so the write and the record's propagation overlap
 * the image delivery and the manifest apply instead of following the whole
 * cluster deploy (DO e2e 2026-10-31: dns.create ran after k3s.full, 290 s in).
 * The orchestrator's post-deploy block calls finish() before the public probe:
 * it awaits that write (a refusal fails the deploy there) and then writes the
 * record itself only when nothing set this IP: the hook never fired, or the
 * final IP differs from the early one. The gate makes that second call a
 * no-op when the early write already set the same IP, so the record is
 * written once. The gate compares with the IP the last run wrote, so a
 * DigitalOcean master this run replaced (its records are at the master's own
 * address) is rewritten at its new address in this same run. Every write first
 * persists its target (`persistOwnedIp`) so destroy owns the record even when
 * the deploy fails before its final save.
 */
import { hasAutomatedDns } from '../../dns-provider.js';
import { perfAsync } from '../../perf.js';
import { requireDnsSetup } from '../dns-result.js';
import { clusterIngressIp } from './ingress-ip.js';

/**
 * @param {{
 *   domain: string|null|undefined,
 *   dnsProvider: string|null|undefined,
 *   dnsToken: string|undefined,
 *   dnsZoneId: string|undefined,
 *   state: import('../state.js').StateTracker,
 *   dnsWarmupPromise: Promise<unknown>,
 *   getDnsProvider: (id: string) => Promise<{setupSimple: Function}>,
 *   persistOwnedIp?: ((target: {ingressIp: string, floatingIp: string|null}) => void)|null,
 * }} o
 */
export function createK8sDnsWriter({
  domain,
  dnsProvider,
  dnsToken,
  dnsZoneId,
  state,
  dnsWarmupPromise,
  getDnsProvider,
  persistOwnedIp = null,
}) {
  const write = async (cluster, progress) => {
    const ip = clusterIngressIp(cluster);
    // On disk before the record points at it: destroy deletes only records
    // whose target it can attribute to this env (planDestroyTargets reads
    // envConfig.ingressIp), so a deploy that fails after this write must
    // already own the IP. The floating IP, where the cluster has one, is
    // recorded with it: destroy's backstop releases that one by address, so
    // it never sees a master's own address. Single k8s only; k8s-ha
    // persists per cluster.
    persistOwnedIp?.({ ingressIp: ip, floatingIp: cluster?.floatingIp || null });
    // The 0.0.0.0 warm-up write targets the same record: never race it.
    await perfAsync('deploy.dns.warm', async () => {
      await dnsWarmupPromise;
    });
    const dnsUpdateInputs = { domain, dnsProvider, serverIp: ip };
    if (state.shouldSkip('k8s-dns-update', dnsUpdateInputs)) return;
    state.startStep('k8s-dns-update', dnsUpdateInputs);
    const { setupSimple: updateDnsIp } = await getDnsProvider(dnsProvider);
    requireDnsSetup(
      await perfAsync('deploy.dns.create', () =>
        progress
          ? updateDnsIp(dnsToken, dnsZoneId, domain, ip, progress)
          : updateDnsIp(dnsToken, dnsZoneId, domain, ip),
      ),
      `DNS A record for ${domain}`,
    );
    state.completeStep('k8s-dns-update', { serverIp: ip });
  };
  let early = null;
  return {
    /** deployK3s's onInfraReady: start the write in the background, once. */
    onInfraReady(infra = {}) {
      if (early || !clusterIngressIp(infra) || !domain || !hasAutomatedDns(dnsProvider)) return;
      // Silent: deployK3s's spinner owns the line, and setupSimple's own
      // spinner (shown when no onProgress is passed) would fight it.
      early = write(infra, { onProgress: () => {} });
      // Awaited (and thrown) by finish(); this only keeps a refusal that lands
      // mid-deploy from being an unhandledRejection before then.
      early.catch(() => {});
    },
    /**
     * The post-deploy barrier: the early write settled, then the cluster's
     * ingress IP set. `cluster` is deployK3s's result.
     *
     * Returns where the records point and when the write that put them there
     * completed (this run's, or an earlier run's the gate found unchanged),
     * from the `k8s-dns-update` step: the deploy's release of a retired
     * reserved IP waits the record's TTL from then
     * (retired-reserved-ip.js). Null when no ingress IP is known.
     *
     * @returns {Promise<{target: string, changedAt: number}|null>}
     */
    async finish(cluster) {
      if (early) await early;
      const ip = clusterIngressIp(cluster);
      if (!ip) return null;
      // write() either finds the step done for this very IP (its inputs hold
      // it) or completes it for this IP, or throws: the step names `ip` here.
      await write(cluster);
      const changedAt = state.getStepCompletedAt('k8s-dns-update');
      return changedAt == null ? null : { target: ip, changedAt };
    },
  };
}
