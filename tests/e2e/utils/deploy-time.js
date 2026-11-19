/**
 * What a cold deploy's budget measures, read from its `[perf]` lines.
 *
 * One module, because the check that judges a deploy
 * (tests/e2e/checks/deploy-budget.ts) and the script that sizes the budgets
 * from past deploys (scripts/calibrate-deploy-budgets.js, plain Node) must
 * measure the same quantity: a budget calibrated on one number and judged on
 * another would pass or fail for the wrong reason.
 *
 * `deploy.total` holds two waits that are not the deploy's own work:
 *
 * - the TLS first look (`deploy.tls.ready` plus `deploy.tls.snapshot`): the
 *   CA validating the new server's HTTP-01 challenge;
 * - the provider's server create: the time from asking the cloud for a server
 *   to the cloud reporting it made, timed per resource from the Pulumi engine
 *   events (`[perf] <stem>.resource.<Type>.<name>`, lib/iac/resource-timing.js).
 *   The same Hetzner k8s deploy saw 29-52 s on most runs and 173-192 s on a
 *   slow day, and a DigitalOcean incident held one droplet 558 s.
 *
 * Only the LONGEST server create is taken out, on purpose. A deploy's servers
 * are created in parallel, so the longest is the provider's wait on the
 * critical path. If our code ever serialized the creates again (a real
 * regression once: ff9a3a00 built each Hetzner worker's replacement trigger
 * from its master's id, so no worker started until the master was made), the
 * creates after the first would add up and that extra time would still count
 * against the deploy.
 */

import { timedTypeName } from '../../../src/lib/iac/resource-timing.js';
import { getProviderClass } from '../../../src/lib/providers/index.js';

const TLS_FIRST_LOOK = new Set(['deploy.tls.ready', 'deploy.tls.snapshot']);

/**
 * The `<Type>` a provider's server creates are timed under, from the server
 * type it declares (SERVER_RESOURCE_TYPE): `Server` on Hetzner, `Droplet` on
 * DigitalOcean.
 *
 * @param {string} provider
 * @returns {string}
 */
export function serverTimingType(provider) {
  const token = getProviderClass(provider).SERVER_RESOURCE_TYPE;
  if (!token) throw new Error(`provider ${provider} declares no SERVER_RESOURCE_TYPE`);
  return timedTypeName(token);
}

/**
 * The `[perf]` name of one of the provider's server creates during a deploy:
 * `deploy.<stem>.resource.<Type>.<name>`.
 *
 * @param {string} provider
 * @returns {RegExp}
 */
export function serverCreatePattern(provider) {
  return new RegExp(`^deploy\\..+\\.resource\\.${serverTimingType(provider)}\\.[^.]+$`);
}

/**
 * The deploy's times in ms, from its `[perf]` entries.
 *
 * `ownedMs` (deploy.total minus the TLS first look and the longest server
 * create) and `endToEndMs` (deploy.total minus the longest server create) are
 * null when either marker they need is missing: a cold deploy always creates
 * its servers, so a log without a server create cannot tell the provider's
 * wait from ours, and is never measured as if it had none.
 *
 * @param {ReadonlyArray<{ name: string, ms: number }>} perf
 * @param {string} provider
 * @returns {{
 *   totalMs: number | null,
 *   tlsMs: number,
 *   serverCreate: { name: string, ms: number } | null,
 *   ownedMs: number | null,
 *   endToEndMs: number | null,
 * }}
 */
export function deployTimes(perf, provider) {
  const isServerCreate = serverCreatePattern(provider);
  let totalMs = null;
  let tlsMs = 0;
  let serverCreate = null;
  for (const { name, ms } of perf) {
    if (name === 'deploy.total') totalMs = Math.max(totalMs ?? ms, ms);
    else if (TLS_FIRST_LOOK.has(name)) tlsMs += ms;
    else if (isServerCreate.test(name) && ms > (serverCreate?.ms ?? -1)) {
      serverCreate = { name, ms };
    }
  }
  const measured = totalMs !== null && serverCreate !== null;
  return {
    totalMs,
    tlsMs,
    serverCreate,
    ownedMs: measured ? totalMs - tlsMs - serverCreate.ms : null,
    endToEndMs: measured ? totalMs - serverCreate.ms : null,
  };
}
