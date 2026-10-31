/**
 * The k8s tiers' domain A record: one record, at the cluster's floating IP
 * (else its master), gated on {domain, provider, ip} by the `k8s-dns-update`
 * state step.
 *
 * Single-cluster k8s starts the write from deployK3s's onInfraReady hook, the
 * moment the cluster's addresses exist, so the write and the record's
 * propagation overlap the image delivery and the manifest apply instead of
 * following the whole cluster deploy (DO e2e 2026-10-31: dns.create ran after
 * k3s.full, 290 s in). The orchestrator's post-deploy block calls finish()
 * before the public probe: it awaits that write (a refusal fails the deploy
 * there) and then writes the record itself when nothing did, which is every
 * k8s-ha deploy (its fan-out owns onInfraReady) and any rerun whose IP moved.
 * The gate makes that second call a no-op when the early write already set
 * the same IP, so the record is written once.
 */
import { hasAutomatedDns } from '../../dns-provider.js';
import { perfAsync } from '../../perf.js';
import { requireDnsSetup } from '../dns-result.js';

/**
 * @param {{
 *   domain: string|null|undefined,
 *   dnsProvider: string|null|undefined,
 *   dnsToken: string|undefined,
 *   dnsZoneId: string|undefined,
 *   state: import('../state.js').StateTracker,
 *   dnsWarmupPromise: Promise<unknown>,
 *   getDnsProvider: (id: string) => Promise<{setupSimple: Function}>,
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
}) {
  const write = async (ip, progress) => {
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
    onInfraReady({ floatingIp, masterIp } = {}) {
      const ip = floatingIp || masterIp;
      if (early || !ip || !domain || !hasAutomatedDns(dnsProvider)) return;
      // Silent: deployK3s's spinner owns the line, and setupSimple's own
      // spinner (shown when no onProgress is passed) would fight it.
      early = write(ip, { onProgress: () => {} });
      // Awaited (and thrown) by finish(); this only keeps a refusal that lands
      // mid-deploy from being an unhandledRejection before then.
      early.catch(() => {});
    },
    /** The post-deploy barrier: the early write settled, then this IP set. */
    async finish(ip) {
      if (early) await early;
      await write(ip);
    },
  };
}
