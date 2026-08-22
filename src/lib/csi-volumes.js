/**
 * CSI volume IDENTITY CAPTURE — read a live cluster's PersistentVolumes and
 * extract the provider-side volume ids sitting behind them.
 *
 * WHY THIS EXISTS
 * ---------------
 * CSI-provisioned block volumes are created OUT-OF-BAND by the in-cluster CSI
 * controller. They are never in Pulumi state, so `pulumi destroy` cannot touch
 * them, and both drivers name them `pvc-<pv-uuid>` with NO project/cluster
 * prefix, so every name-based sweep is structurally blind to them. The destroy
 * that deletes the SERVERS detaches the volumes and strands them — billable,
 * forever. Three occurrences (2026-07-29 six nbg1 volumes after a fully GREEN
 * k8s run; 2026-07-31 three after an e3 destroy whose `pulumi destroy` itself
 * 403'd; 2026-08-05 five across hel1+nbg1 after a k8s-ha destroy that printed
 * "No orphaned volumes found"), all hand-deleted.
 *
 * Before this module the only attribution destroy had was
 * `server.volumes` — the ids of volumes ATTACHED to a cluster server at the
 * instant of the pre-scan. That misses:
 *   - every volume already detached at destroy time (pilot-light standby,
 *     scale-from-zero worker pool, a pod evicted, a node lost to a partial
 *     teardown),
 *   - EVERYTHING, if the pre-scan's own `listNetworks`/`listServers` call
 *     soft-fails (both return `[]` on a non-ok response) — which then leaves
 *     `clusterLocations` empty too, disabling the one heuristic that could
 *     have caught them.
 *
 * The cluster itself knows the answer exactly: every CSI volume it owns has a
 * PersistentVolume object whose `spec.csi.volumeHandle` IS the provider volume
 * id, attached or not. Capturing that list while the API server is still up
 * turns a heuristic into an identity.
 *
 * WHAT THE DRIVERS ACTUALLY GIVE US (verified 2026-08-05, versions as pinned
 * by carbon/cloud-init/k3s/{master,do-master}-init.sh):
 *
 *   hcloud csi-driver v2.18.1 (`csi.hetzner.cloud`)
 *     - `spec.csi.volumeHandle` = the Hetzner volume id as a STRING
 *       (`VolumeId: strconv.FormatInt(volume.ID, 10)`), so it must be compared
 *       to `volume.id` (a NUMBER over the wire) by string key — see idKey() in
 *       destroy.js.
 *     - topology segment key `csi.hetzner.cloud/location`
 *       (`TopologySegmentLocation = PluginName + "/location"`), surfaced on the
 *       PV as `spec.nodeAffinity.required.nodeSelectorTerms[].matchExpressions`.
 *     - LABELS: yes, since the v2.9.0 -> v2.18.1 bump. CreateVolume seeds
 *       `managed-by=csi-driver`, copies in whatever
 *       `HCLOUD_VOLUME_EXTRA_LABELS` parsed to (master-init.sh sets
 *       `project=<name>`), and adds `pvc-name` / `pvc-namespace` / `pv-name`
 *       from the CreateVolume parameters csi-provisioner supplies under
 *       `--extra-create-metadata` (cmd/main.go:128 ->
 *       internal/driver/controller.go:87-118).
 *       HISTORY, because the fix reads oddly without it: that env-var line was
 *       added by the 2026-07-18 RCA and was a NO-OP for the next three weeks.
 *       Upstream only added volume labelling in v2.14.0 ("allow to set labels
 *       for all volumes", #932; v2.14.0 is explicitly "do not install", use
 *       >= v2.15.0), and v2.9.0's cmd/controller/main.go read exactly one env
 *       var, HCLOUD_VOLUME_DEFAULT_LOCATION. That is why every leaked volume
 *       in all three occurrences above was unlabelled — the label matches in
 *       destroy.js were wired against a driver that could not stamp them.
 *
 *   csi-digitalocean v4.17.0 (`dobs.csi.digitalocean.com`)
 *     - `spec.csi.volumeHandle` = the DO volume UUID (string).
 *     - topology segment key `region` (CreateVolume returns
 *       `Segments: {"region": d.region}`).
 *     - NO TAGS unless the driver is started with `--do-tag`
 *       (`if d.doTag != "" { volumeReq.Tags = append(...) }`); do-master-init.sh
 *       does not pass it, so DO CSI volumes carry no tags at all.
 *
 * Net: Hetzner CSI volumes created from the v2.18.1 bump onward DO carry
 * ownership labels; DigitalOcean's carry nothing, and neither does any Hetzner
 * volume created before the bump. Identity capture from the cluster is
 * therefore still the PRIMARY layer — it is the only one that works on both
 * providers, on pre-bump volumes, and at environment (not project) scope. The
 * labels upgrade the degraded-mode backstop in destroy.js from "a pvc-* volume
 * in one of our regions" to "a pvc-* volume this project's CSI controller
 * created", which is what the sweep and the destroy backstop key off.
 */

import { existsSync as nodeExistsSync } from 'node:fs';
import { runCommand as nodeRunCommand } from './command.js';

/**
 * CSI drivers whose `volumeHandle` we know how to hand to a provider's
 * `deleteVolume()`. A PV from any other driver (local-path, longhorn, nfs, a
 * foreign cloud) is deliberately IGNORED rather than guessed at — deleting by
 * an id we can't interpret is how you delete the wrong thing.
 *
 * `regionKeys` are the PV nodeAffinity matchExpression keys each driver writes
 * its topology segment under (see the module doc for the upstream constants).
 */
export const CSI_DRIVERS = {
  'csi.hetzner.cloud': {
    providerId: 'hetzner',
    regionKeys: ['csi.hetzner.cloud/location'],
  },
  'dobs.csi.digitalocean.com': {
    providerId: 'digitalocean',
    regionKeys: ['region', 'topology.kubernetes.io/region'],
  },
};

/**
 * Generic region keys tried after the driver-specific ones. Harmless when
 * absent; catches a driver that starts publishing the standard well-known
 * label without us noticing.
 */
const GENERIC_REGION_KEYS = [
  'topology.kubernetes.io/region',
  'failure-domain.beta.kubernetes.io/region',
  'region',
];

/**
 * Both drivers name provisioned volumes `pvc-<pv-uuid>`. Anchored + full-UUID
 * so an operator's hand-named `pvc-backups` volume can never be mistaken for a
 * CSI orphan. Kept in lockstep with scripts/sweep-hetzner.js's copy (that file
 * is plain node with no src imports by design — see its header).
 */
const CSI_VOLUME_NAME_RE = /^pvc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {unknown} name
 * @returns {boolean} true when `name` is a CSI-provisioned volume name.
 */
export function isCsiVolumeName(name) {
  return typeof name === 'string' && CSI_VOLUME_NAME_RE.test(name);
}

/**
 * Pull the region(s) a PV is pinned to out of its nodeAffinity terms.
 *
 * @param {object} pv - A PersistentVolume object.
 * @param {string[]} driverKeys - Driver-specific topology keys, tried first.
 * @returns {string[]} Region slugs (possibly empty — nodeAffinity is optional).
 */
function regionsFromNodeAffinity(pv, driverKeys) {
  const keys = new Set([...driverKeys, ...GENERIC_REGION_KEYS]);
  const terms = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
  const regions = new Set();
  for (const term of terms) {
    for (const expr of term?.matchExpressions ?? []) {
      if (!keys.has(expr?.key)) continue;
      for (const value of expr?.values ?? []) {
        if (typeof value === 'string' && value) regions.add(value);
      }
    }
  }
  return [...regions];
}

/**
 * Parse a `kubectl get pv -o json` payload into provider volume identities.
 *
 * Tolerant by design: a malformed item is skipped, not thrown on. This runs on
 * the teardown path, where the only thing worse than a partial answer is an
 * exception that costs us the whole answer.
 *
 * @param {object|string} payload - Parsed JSON, or the raw stdout string.
 * @returns {{ volumes: Array<{ pvName: string, driver: string, providerId: string, volumeId: string, regions: string[], phase: string|null, reclaimPolicy: string|null }>, skippedDrivers: string[] }}
 *   `skippedDrivers` lists distinct CSI drivers present in the cluster that we
 *   do NOT know how to delete against — surfaced so an unrecognised storage
 *   backend shows up in the destroy report instead of silently leaking.
 */
export function parseCsiPersistentVolumes(payload) {
  let doc = payload;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return { volumes: [], skippedDrivers: [] };
    }
  }
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const volumes = [];
  const skipped = new Set();
  const seen = new Set();

  for (const pv of items) {
    const csi = pv?.spec?.csi;
    const driver = csi?.driver;
    if (!driver || typeof driver !== 'string') continue; // non-CSI PV (hostPath, local, nfs)
    const known = CSI_DRIVERS[driver];
    if (!known) {
      skipped.add(driver);
      continue;
    }
    const handle = csi.volumeHandle;
    if (handle === undefined || handle === null || handle === '') continue;
    const volumeId = String(handle);
    if (seen.has(volumeId)) continue;
    seen.add(volumeId);
    volumes.push({
      pvName: pv?.metadata?.name ?? '',
      driver,
      providerId: known.providerId,
      volumeId,
      regions: regionsFromNodeAffinity(pv, known.regionKeys),
      phase: pv?.status?.phase ?? null,
      reclaimPolicy: pv?.spec?.persistentVolumeReclaimPolicy ?? null,
    });
  }

  return { volumes, skippedDrivers: [...skipped] };
}

/**
 * Ask a live cluster for the provider volume ids behind its PersistentVolumes.
 *
 * MUST be called while the API server is still reachable — i.e. BEFORE the
 * namespace delete and long before `pulumi destroy`. A failure here is not
 * fatal (the caller falls through to the degraded backstop) but it MUST be
 * reported: `ok: false` is exactly the state in which destroy is no longer
 * able to prove it cleaned up, and quietly printing "No orphaned volumes
 * found" over it is the bug this whole change exists to kill.
 *
 * @param {string} kubeconfigPath
 * @param {object} [deps] - Test seams.
 * @param {(cmd: string[], opts?: object) => unknown} [deps.runCommand]
 * @param {(path: string) => boolean} [deps.existsSync]
 * @param {number} [deps.timeoutSeconds] - kubectl --request-timeout budget.
 * @returns {{ ok: boolean, volumes: object[], volumeIds: string[], regions: string[], skippedDrivers: string[], reason: string|null }}
 */
export function captureClusterCsiVolumes(kubeconfigPath, deps = {}) {
  const { runCommand = nodeRunCommand, existsSync = nodeExistsSync, timeoutSeconds = 60 } = deps;

  const empty = { ok: false, volumes: [], volumeIds: [], regions: [], skippedDrivers: [] };

  if (!kubeconfigPath || !existsSync(kubeconfigPath)) {
    return { ...empty, reason: `no kubeconfig at ${kubeconfigPath}` };
  }

  let stdout;
  try {
    stdout = runCommand(
      [
        'kubectl',
        '--kubeconfig',
        kubeconfigPath,
        'get',
        'pv',
        '-o',
        'json',
        `--request-timeout=${timeoutSeconds}s`,
      ],
      // silent + returnOutput so a non-zero exit THROWS (runCommand's contract)
      // rather than returning a falsy value we would have to guess about.
      { silent: true, returnOutput: true },
    );
  } catch (error) {
    return { ...empty, reason: `kubectl get pv failed: ${error.message}` };
  }

  if (typeof stdout !== 'string' || stdout.trim() === '') {
    return { ...empty, reason: 'kubectl get pv returned no output' };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return { ...empty, reason: `kubectl get pv output was not JSON: ${error.message}` };
  }
  // A payload with no `items` array is a shape we don't understand — treat it
  // as a failed capture, NOT as "this cluster has zero PVs". The two are
  // indistinguishable from the caller's side and only one of them is safe.
  if (!Array.isArray(parsed?.items)) {
    return { ...empty, reason: 'kubectl get pv output had no items array' };
  }

  const { volumes, skippedDrivers } = parseCsiPersistentVolumes(parsed);
  const regions = new Set();
  for (const volume of volumes) for (const region of volume.regions) regions.add(region);

  return {
    ok: true,
    volumes,
    volumeIds: volumes.map((v) => v.volumeId),
    regions: [...regions],
    skippedDrivers,
    reason: null,
  };
}
