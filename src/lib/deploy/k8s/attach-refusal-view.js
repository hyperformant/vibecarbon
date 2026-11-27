/**
 * When the provider refused to attach the db volume and the refusal held
 * (VolumeAttachRefusedError, watchDbAttach in ../replication.js), the deploy
 * records what the provider says about the database server and about the
 * volume, one `[db]` log line per fact, before it fails.
 *
 * WHY (Vultr runs 45940611622 and 45966805225, 2026-11-27, vultr/k8s
 * restore-deploy): each time a fresh vc2-4c-8gb database server in ewr took
 * no NVMe block volume for 900 s ("Block storage is not compatible with this
 * server", status 400), and the rig was destroyed with nothing recorded of
 * the server's plan or the volume's type, region and attachment. Our code
 * cannot choose where the provider places a server; the next hit should at
 * least carry the provider's own facts.
 *
 * Diagnosis only: GETs, bounded, never retried, and it never throws, so the
 * failure it describes is reported as it was. Only named fields are printed
 * (a Vultr instance read also carries its root password and a console URL).
 */

import { parseCsiPersistentVolumes } from '../../csi-volumes.js';
import { describeServersForLog } from './node-join.js';

/** The bound on each half (the server, the volume): node-join.js's provider view budget. */
const VIEW_BUDGET_MS = 30_000;

/** A PersistentVolume name kubectl is handed: a DNS subdomain, as Kubernetes names it. */
const K8S_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** The first line of an error, for one log line. */
function firstLine(err) {
  return String(err?.message ?? err)
    .split('\n')[0]
    .slice(0, 300);
}

/**
 * Log what the provider says about the database server and the db volume a
 * refused attach left Pending. The server is found as node-join.js finds one
 * (by id, else by its public address), and its view gets the plan; the
 * volume's provider id is its PersistentVolume's CSI handle (`readPv`, then
 * csi-volumes.js), read with the provider's describeVolumeForDiagnosis,
 * which is null on a provider without such a read. Each half is bounded by
 * `budgetMs` and both run at once.
 *
 * @param {object} args
 * @param {import('../../providers/base.js').BaseProvider} args.provider
 * @param {typeof import('../../providers/base.js').BaseProvider} args.Provider
 * @param {import('./node-join.js').ExpectedNode} args.dbNode - the database server, as the provisioning made it
 * @param {string} args.volume - the PersistentVolume the refusal named
 * @param {(name: string) => Promise<string>} args.readPv - `kubectl get pv <name> -o json`, bounded
 * @param {(line: string) => void} [args.log]
 * @param {number} [args.budgetMs]
 * @returns {Promise<void>}
 */
export async function logAttachRefusalView({
  provider,
  Provider,
  dbNode,
  volume,
  readPv,
  log = (line) => console.error(line),
  budgetMs = VIEW_BUDGET_MS,
}) {
  const providerName = Provider?.NAME || 'the provider';
  // Both halves read at once; their lines are printed server first, and a
  // line that arrives after its half's budget is dropped.
  const serverLines = [];
  const volumeLines = [];
  const server = describeServersForLog({
    provider,
    Provider,
    nodes: [dbNode],
    budgetMs,
    log: (line) => serverLines.push(line),
    tag: 'db',
  }).catch((err) =>
    serverLines.push(
      `[db] could not read ${providerName}'s view of the database server: ${firstLine(err)}`,
    ),
  );
  const volumeView = bounded(
    () =>
      logVolumeView({
        provider,
        providerName,
        volume,
        readPv,
        log: (line) => volumeLines.push(line),
      }),
    budgetMs,
    () =>
      volumeLines.push(
        `[db] stopped reading ${providerName}'s view of the db volume ${volume} after ${Math.round(budgetMs / 1000)}s`,
      ),
  );
  await Promise.all([server, volumeView]);
  for (const line of [...serverLines.splice(0), ...volumeLines.splice(0)]) {
    try {
      log(line);
    } catch {
      // a log that throws never replaces the failure this describes
    }
  }
}

/** Run `work`, never past `budgetMs` (then `onExpired`), and never throw. */
async function bounded(work, budgetMs, onExpired) {
  const run = Promise.resolve()
    .then(work)
    .catch(() => {});
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
    timer.unref?.();
  });
  const outcome = await Promise.race([run.then(() => 'done'), expired]);
  clearTimeout(timer);
  if (outcome === 'expired') onExpired();
}

/** The volume half: its PersistentVolume, then the provider's view of the volume behind it. */
async function logVolumeView({ provider, providerName, volume, readPv, log }) {
  if (!K8S_NAME.test(String(volume))) {
    log(
      `[db] the refusal named no PersistentVolume (${volume}), so ${providerName}'s view of the volume was not read`,
    );
    return;
  }
  let pv;
  try {
    pv = JSON.parse(String(await readPv(volume)));
  } catch (err) {
    log(
      `[db] could not read the PersistentVolume ${volume}, so ${providerName}'s view of the volume was not read: ${firstLine(err)}`,
    );
    return;
  }
  const { volumes } = parseCsiPersistentVolumes({ items: [pv] });
  const id = volumes[0]?.volumeId;
  if (!id) {
    const csi = pv?.spec?.csi ?? {};
    log(
      `[db] the PersistentVolume ${volume} names no volume id ${providerName}'s view can be read by ` +
        `(driver ${csi.driver ?? 'none'}, handle ${csi.volumeHandle ?? 'none'})`,
    );
    return;
  }
  let view;
  try {
    view = await provider.describeVolumeForDiagnosis(id);
  } catch (err) {
    log(
      `[db] could not read ${providerName}'s view of the db volume ${volume} (id ${id}): ${firstLine(err)}`,
    );
    return;
  }
  if (!view) {
    log(
      `[db] ${providerName}'s view of the db volume ${volume} (id ${id}) was not read: this provider has no read of a volume`,
    );
    return;
  }
  log(
    `[db] ${providerName}'s view of the db volume ${volume} (id ${id}): type ${view.blockType ?? '?'}, ` +
      `region ${view.region ?? '?'}, size ${view.sizeGb ?? '?'} GB, status ${view.status ?? '?'}, ` +
      `${view.attachedToInstance ? `attached to instance ${view.attachedToInstance}` : 'attached to no instance'}, ` +
      `created ${view.created ?? '?'}`,
  );
}
