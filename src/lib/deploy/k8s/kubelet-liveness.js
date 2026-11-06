import { pollUntil } from '../../retry.js';

// A kubelet renews its node Lease every 10 s, so two renewals past the first
// read mean it has been up for at least that long. One is not enough: the
// first can land seconds after the kubelet starts, before it has told the API
// that its pods died with the reboot.
const RENEWALS_REQUIRED = 2;
const BUDGET_MS = 300_000;
const INTERVAL_MS = 3000;

/**
 * Wait until every node's kubelet is alive and has reported in. Provider
 * calls return when a resized server powers back on, which is well before its
 * kubelet runs, and until the node controller's grace period ends (about 40 s)
 * the API still shows that node Ready and its dead pods Ready too. Any wait
 * that reads those conditions passes on the stale answer, so this reads the
 * one thing a dead kubelet cannot fake.
 *
 * The first read is the baseline, so nothing has to be captured before the
 * resize and no node has to be matched to a server type. A node that never
 * rebooted renews on its own within 20 s.
 *
 * @param {object} options
 * @param {() => string|Promise<string>} options.readLeases `kubectl get leases
 *   -n kube-node-lease -o json` output. May throw while the API comes back.
 * @param {number} [options.budgetMs]
 * @param {number} [options.intervalMs] Must stay under the 10 s renew period,
 *   or two renewals can fall between reads and count as one.
 * @returns {Promise<{settled: boolean, pending: string[]}>} Never throws at the
 *   budget: by then the API has marked a dead node's pods NotReady, so the pod
 *   wait that follows reports the real state with better detail than this can.
 */
export async function waitForKubeletsRenewing({
  readLeases,
  budgetMs = BUDGET_MS,
  intervalMs = INTERVAL_MS,
}) {
  /** @type {Map<string, {renewTime: string, renewals: number}>} */
  const nodes = new Map();
  const pending = () =>
    [...nodes].filter(([, n]) => n.renewals < RENEWALS_REQUIRED).map(([name]) => name);

  const probe = async () => {
    const { items } = JSON.parse(await readLeases());
    const current = new Map(items.map((l) => [l.metadata.name, l.spec.renewTime]));
    for (const name of nodes.keys()) if (!current.has(name)) nodes.delete(name);
    for (const [name, renewTime] of current) {
      const node = nodes.get(name);
      if (!node) nodes.set(name, { renewTime, renewals: 0 });
      else if (node.renewTime !== renewTime) {
        node.renewTime = renewTime;
        node.renewals += 1;
      }
    }
    return nodes.size > 0 && pending().length === 0;
  };

  try {
    await pollUntil(probe, {
      budgetMs,
      initialDelayMs: intervalMs,
      backoffFactor: 1,
      description: 'kubelets renewing their node leases',
    });
    return { settled: true, pending: [] };
  } catch {
    return { settled: false, pending: pending() };
  }
}
