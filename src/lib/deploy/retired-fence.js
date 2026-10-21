/**
 * Self-enforcing retirement (HA-correctness Task 6, R7).
 *
 * A failover often finishes with the old primary unreachable: that is usually
 * why it ran. Nothing then demoted it, so when it comes back it still believes
 * it is the primary. Its app serves stale data to any client on old DNS, its
 * add-ons and pg_cron keep writing, its archive_command pushes WAL into the
 * backup prefix the new primary owns, and its nightly base backup does too,
 * ending in a `wal-g delete retain` that can prune the new primary's backups.
 * Until a deploy rebuilds it as the standby, the side the persisted roles call
 * retired is fenced by markers it enforces itself:
 *
 *   - k8s: `VIBECARBON_ROLE=retired` in the `vibecarbon-config` ConfigMap,
 *     which the backup CronJob reads per job (configMapKeyRef);
 *   - compose: the file `<remoteDir>/.vibecarbon-retired`, which
 *     `backup/compose-backup.sh` checks before it reaches the db container;
 *   - both: a `vibecarbon-retired` file in PGDATA. archive_command runs inside
 *     the db container, which sees neither marker above (container env is
 *     fixed at start, and the host directory is not mounted), so wal-archive.sh
 *     checks this one. A reseed replaces PGDATA, which takes it away with the
 *     retired data it fences.
 *
 * Each script exits 1 with `retired node: backups refused` before any wal-g
 * call: a refused push fails loudly and never counts as a skip.
 *
 * Writes are refused at the database itself: `default_transaction_read_only =
 * on` through ALTER SYSTEM (the same setting and helper the planned-failover
 * fence uses, so every writer is covered, app, add-ons and pg_cron alike, and
 * open sessions are terminated). A db in recovery cannot write and is left
 * alone. Besides that the fence holds the retired side's writers at zero (k8s:
 * the app and every deployed add-on through `kubectl scale --replicas=0`,
 * never a patch that would roll pods, after suspending any Flux Kustomization
 * that would scale them back; compose: the app and the primary-only add-ons)
 * and WALG_ROLE=standby.
 *
 * `vibecarbon status`, `failover` and `deploy` call reconcileRetiredFence
 * first, and failover again once its role swap is saved, so an old primary
 * that returns is fenced by whichever command reaches it next. The reconciler
 * reads first and writes only what is missing: an already fenced side costs no
 * write.
 *
 * The fence comes off in two places only, once the retired side has been
 * rebuilt as a proven replica: the compose reconverge's haFinalizeConfig and
 * the k8s-ha deploy after its streaming gate (clearRetiredFence; the
 * retired-fence-entrypoints census pins both). The stranded-fence lifter
 * (write-fence.js) never touches a retired node.
 */

import * as p from '@clack/prompts';
import {
  composeWriterServices,
  declaredAddonNames,
  enabledAddonNames,
  k8sStandbyZeroedWorkloads,
} from '../services/standby-policy.js';
import { getSSHKeyPath, sshKubectl } from '../ssh.js';
import { sshRun as composeSshRun } from './compose/index.js';
import { DB_CONTAINER, DB_POD, DB_STATEFULSET } from './db-workload.js';
import { swappedSinceLastDeploy } from './failover-guard.js';
import { fenceDatabaseWrites, k8sPsqlRunner, WRITE_FENCE_SETTING } from './replication.js';
import { demoteK8sWalgRole, k8sDbRolloutStatusArgv } from './walg-role.js';

/** The vibecarbon-config key the k8s backup CronJob reads. */
export const RETIRED_ROLE_KEY = 'VIBECARBON_ROLE';
export const RETIRED_ROLE = 'retired';
/** compose: `<remoteDir>/.vibecarbon-retired`, checked by compose-backup.sh. */
export const RETIRED_HOST_MARKER = '.vibecarbon-retired';
/** both tiers: `$PGDATA/vibecarbon-retired`, checked by wal-archive.sh. */
export const RETIRED_DB_MARKER = 'vibecarbon-retired';
/** The one line every backup script prints when it refuses. */
export const RETIRED_REFUSAL = 'retired node: backups refused';
/** The annotation on a Flux Kustomization the fence suspended (so the clear resumes only those). */
export const FLUX_SUSPENDED_BY = 'vibecarbon.dev/suspended-by';
const FLUX_SUSPENDED_BY_VALUE = 'retired-fence';

/** The app Deployment the k8s fence zeroes (k8s/base/app/deployment.yaml). */
const K8S_APP_DEPLOYMENT = 'app';
const NS = 'vibecarbon';
/** The Flux Kustomizations of k8s/flux/clusters/*: vibecarbon-base and its overlays. */
const FLUX_NS = 'flux-system';
const FLUX_KUSTOMIZATION = 'kustomizations.kustomize.toolkit.fluxcd.io';
const FLUX_PREFIX = 'vibecarbon-';
/** PGDATA as the db container resolves it (the image sets PGDATA). */
const DB_MARKER_PATH = `"\${PGDATA:-/var/lib/postgresql/data}/${RETIRED_DB_MARKER}"`;
/** Reads are bounded: status calls this, and an unreachable side must not stall it. */
const PROBE_TIMEOUT_MS = 20_000;
/** The db roll a WALG_ROLE change triggers, waited before the second pass. */
const DB_SETTLE_TIMEOUT_S = 120;

/** The fence parts that live in the database pod (the ones a db settle can make readable). */
const DB_KEYS = ['dbMarker', 'dbReadOnly'];

/** One read: recovery, the fence setting, and the pg_wal size (the retired node's disk clock). */
export const RETIRED_DB_STATE_SQL =
  `SELECT pg_is_in_recovery(), current_setting('${WRITE_FENCE_SETTING}'), ` +
  '(SELECT coalesce(sum(size), 0) FROM pg_ls_waldir())';

/** The fence setting as written to the settings files, which is what a promotion would read. */
const FILE_SETTING_SQL = `SELECT count(*) FROM pg_file_settings WHERE name = '${WRITE_FENCE_SETTING}'`;

/**
 * The HA tier of a persisted env, or null for a non-HA (or unknown) one.
 *
 * @param {object} envConfig
 * @returns {'compose-ha'|'k8s-ha'|null}
 */
export function haTierOf(envConfig) {
  if (envConfig?.deployMode === 'compose-ha') return 'compose-ha';
  const ha = envConfig?.ha;
  const haEnabled = typeof ha === 'object' ? !!ha?.enabled : !!ha;
  if (envConfig?.deployMode === 'kubernetes' && haEnabled) return 'k8s-ha';
  return null;
}

/**
 * The sides the persisted roles call retired: the standby side of a pair a
 * failover swapped that no deploy has reconverged since. Pure.
 *
 * @param {{ envConfig: object, tier: 'compose-ha'|'k8s-ha' }} args
 * @returns {Array<{ ip: string, name?: string }>}
 */
export function retiredSides({ envConfig, tier }) {
  if (!swappedSinceLastDeploy(envConfig)) return [];
  if (tier === 'compose-ha') {
    return (envConfig.servers ?? [])
      .filter((sv) => sv?.role === 'standby' && sv.ip)
      .map((sv) => ({ ip: sv.ip, ...(sv.name && { name: sv.name }) }));
  }
  if (tier === 'k8s-ha') {
    const ip = envConfig.ha?.standby?.masterIp;
    return ip ? [{ ip }] : [];
  }
  return [];
}

/** True when `ip` is a side the persisted roles call retired, on either HA tier. */
export function isRetiredSide(envConfig, ip) {
  return (
    !!ip &&
    ['compose-ha', 'k8s-ha'].some((tier) =>
      retiredSides({ envConfig, tier }).some((side) => side.ip === ip),
    )
  );
}

/**
 * Read the db's fence state through a psql runner.
 * readOnly: true when fenced or in recovery (a replica cannot write), false
 * when it takes writes, 'unknown' when the db does not answer.
 */
async function probeDb(exec) {
  let out;
  try {
    out = await exec(RETIRED_DB_STATE_SQL);
  } catch {
    return { readOnly: 'unknown', walBytes: null };
  }
  const [rec, setting, wal] = String(out ?? '')
    .trim()
    .split('\n')
    .pop()
    .split('|')
    .map((s) => s.trim());
  const walBytes = /^\d+$/.test(wal ?? '') ? Number(wal) : null;
  if (rec === 't') return { readOnly: true, walBytes };
  if (rec === 'f' && (setting === 'on' || setting === 'off')) {
    return { readOnly: setting === 'on', walBytes };
  }
  return { readOnly: 'unknown', walBytes };
}

const attempt = async (fn) => {
  try {
    const out = await fn();
    return out !== false;
  } catch {
    return false;
  }
};

/** The database-level write fence (fenceDatabaseWrites: ALTER SYSTEM, reload, read back, terminate sessions). */
const fenceDbStep = (psqlFor) => ({
  key: 'dbReadOnly',
  what: 'its database read-only',
  apply: (ip) => attempt(() => fenceDatabaseWrites({ exec: psqlFor(ip) })),
});

/**
 * Lift the database-level fence from the settings files (a promotion reads
 * them), then prove it gone from the files. Throws.
 */
async function clearDbReadOnly(exec) {
  const count = async () => String((await exec(FILE_SETTING_SQL)) ?? '').trim();
  if ((await count()) === '0') return;
  // readWrite: a read-only default session refuses ALTER commands.
  await exec(`ALTER SYSTEM RESET ${WRITE_FENCE_SETTING}`, { readWrite: true });
  await exec('SELECT pg_reload_conf()');
  const left = await count();
  if (left !== '0') throw new Error(`${WRITE_FENCE_SETTING} is still in its settings files`);
}

// ---------------------------------------------------------------------------
// k8s-ha: kubectl over ssh on the retired cluster's master
// ---------------------------------------------------------------------------

const k8sDbMarkerExec = (script) => [
  '-n',
  NS,
  'exec',
  DB_POD,
  '-c',
  DB_CONTAINER,
  '--',
  'sh',
  '-c',
  script,
];

const NO_FLUX =
  /doesn't have a resource type|no matches for kind|could not find the requested resource/i;

const fluxPatch = (suspend) =>
  JSON.stringify({
    metadata: { annotations: { [FLUX_SUSPENDED_BY]: suspend ? FLUX_SUSPENDED_BY_VALUE : null } },
    spec: { suspend },
  });

/** The vibecarbon Flux Kustomizations, or null when Flux is not installed. Throws on any other failure. */
async function listFluxKustomizations(ip, kubectl, opts) {
  let out;
  try {
    out = await kubectl(ip, ['-n', FLUX_NS, 'get', FLUX_KUSTOMIZATION, '-o', 'json'], opts);
  } catch (err) {
    if (NO_FLUX.test(String(err?.message ?? err))) return null;
    throw err;
  }
  return (JSON.parse(out)?.items ?? []).filter((k) =>
    String(k?.metadata?.name ?? '').startsWith(FLUX_PREFIX),
  );
}

/**
 * The workloads the k8s fence holds at zero: the app, then every declared
 * add-on workload (k8sStandbyZeroedWorkloads over all of services/), installed
 * on the retired cluster or not. The retired side is the old primary, whose
 * add-ons need not match the local k8s tree (or a command run outside the
 * project), so the fence never narrows the list to what is installed here: an
 * absent Deployment reads as zero and costs only its share of a read.
 */
function k8sFencedWorkloads() {
  return [
    { kind: 'Deployment', name: K8S_APP_DEPLOYMENT, namespace: NS },
    ...k8sStandbyZeroedWorkloads(declaredAddonNames()),
  ];
}

const listItems = (out) => {
  const text = String(out ?? '').trim();
  if (!text) return [];
  const listed = JSON.parse(text);
  return listed?.kind === 'List' ? (listed.items ?? []) : [listed];
};

/**
 * The fenced workloads not at zero, as `{kind, name, namespace}`. One read per
 * namespace beyond the app's (the app namespace rides the probe's main read);
 * a workload that does not exist counts as zero. A namespace whose read fails
 * lists all its workloads: the zero step scales them anyway (kubectl scale is
 * idempotent and a NotFound counts as zero), so one unreadable add-on
 * namespace never keeps the app from being zeroed.
 */
async function k8sWorkloadsNotZero(ip, { kubectl, workloads, appNsItems, opts }) {
  const byNs = new Map();
  for (const w of workloads) byNs.set(w.namespace, [...(byNs.get(w.namespace) ?? []), w]);
  const live = [];
  for (const [namespace, list] of byNs) {
    let items = appNsItems;
    if (namespace !== NS) {
      try {
        items = listItems(
          await kubectl(
            ip,
            [
              '-n',
              namespace,
              'get',
              ...list.map((w) => `${w.kind.toLowerCase()}/${w.name}`),
              '-o',
              'json',
              '--ignore-not-found',
            ],
            opts,
          ),
        );
      } catch {
        live.push(...list);
        continue;
      }
    }
    for (const w of list) {
      const obj = items.find((i) => i?.kind === w.kind && i?.metadata?.name === w.name);
      if (obj && obj.spec?.replicas !== 0) live.push(w);
    }
  }
  return live;
}

const NOT_FOUND = /NotFound|not found/i;

/** One read of everything the k8s fence covers; null when the cluster does not answer. */
async function probeK8s(ip, { kubectl, psqlFor, workloads }) {
  const opts = { timeout: PROBE_TIMEOUT_MS, transportRetry: false };
  let items;
  try {
    items = listItems(
      await kubectl(
        ip,
        [
          '-n',
          NS,
          'get',
          'configmap/vibecarbon-config',
          ...workloads
            .filter((w) => w.namespace === NS)
            .map((w) => `${w.kind.toLowerCase()}/${w.name}`),
          `statefulset/${DB_STATEFULSET}`,
          '-o',
          'json',
          '--ignore-not-found',
        ],
        opts,
      ),
    );
  } catch {
    return null;
  }
  const of = (kind) => items.find((i) => i?.kind === kind);
  const workloadsToZero = await k8sWorkloadsNotZero(ip, {
    kubectl,
    workloads,
    appNsItems: items,
    opts,
  });
  const db = (of('StatefulSet')?.spec?.template?.spec?.containers ?? []).find(
    (ct) => ct.name === DB_CONTAINER,
  );
  let dbMarker = 'unknown';
  try {
    const out = await kubectl(
      ip,
      k8sDbMarkerExec(`if [ -f ${DB_MARKER_PATH} ]; then echo present; else echo absent; fi`),
      opts,
    );
    const v = String(out ?? '').trim();
    if (v === 'present' || v === 'absent') dbMarker = v === 'present';
  } catch {
    // db pod not running: the second pass, after the db settles, retries.
  }
  let fluxSuspended = 'unknown';
  let fluxToSuspend = [];
  try {
    const ks = await listFluxKustomizations(ip, kubectl, opts);
    fluxToSuspend = (ks ?? []).filter((k) => k?.spec?.suspend !== true).map((k) => k.metadata.name);
    fluxSuspended = fluxToSuspend.length === 0;
  } catch {
    // unreadable: reported as missing, never guessed absent
  }
  const dbState = await probeDb(psqlFor(ip));
  return {
    marker: of('ConfigMap')?.data?.[RETIRED_ROLE_KEY] === RETIRED_ROLE,
    dbMarker,
    dbReadOnly: dbState.readOnly,
    walBytes: dbState.walBytes,
    fluxSuspended,
    fluxToSuspend,
    workloadsZero: workloadsToZero.length === 0,
    workloadsToZero,
    walgStandby: (db?.env ?? []).find((e) => e.name === 'WALG_ROLE')?.value === 'standby',
  };
}

function k8sBackend({ kubectl, psqlFor, zeroWorkloads, workloads }) {
  return {
    probe: (ip) => probeK8s(ip, { kubectl, psqlFor, workloads }),
    // Ordered so backups are refused first, the database stops taking writes
    // next, Flux cannot scale the app back before it is zeroed, and the db
    // marker lands before the WALG_ROLE change rolls the db pod.
    steps: [
      {
        key: 'marker',
        what: 'the retired marker in vibecarbon-config',
        apply: (ip) =>
          attempt(() =>
            kubectl(ip, [
              '-n',
              NS,
              'patch',
              'configmap',
              'vibecarbon-config',
              '--type=merge',
              '-p',
              JSON.stringify({ data: { [RETIRED_ROLE_KEY]: RETIRED_ROLE } }),
            ]),
          ),
      },
      {
        key: 'dbMarker',
        what: 'the PGDATA marker',
        apply: (ip) =>
          attempt(async () => {
            const out = await kubectl(ip, k8sDbMarkerExec(`touch ${DB_MARKER_PATH} && echo OK`));
            if (String(out ?? '').trim() !== 'OK') throw new Error('touch did not confirm');
          }),
      },
      fenceDbStep(psqlFor),
      {
        key: 'fluxSuspended',
        what: 'its Flux Kustomizations suspended',
        apply: (ip, state) =>
          attempt(async () => {
            for (const name of state.fluxToSuspend) {
              await kubectl(ip, [
                '-n',
                FLUX_NS,
                'patch',
                FLUX_KUSTOMIZATION,
                name,
                '--type=merge',
                '-p',
                fluxPatch(true),
              ]);
            }
          }),
      },
      {
        key: 'workloadsZero',
        what: 'its app and add-ons at zero',
        apply: (ip, state) =>
          zeroWorkloads
            ? zeroWorkloads(ip)
            : // kubectl scale, never a patch or set image: those would roll pods.
              // Every workload is tried (the app first), so one failing add-on
              // namespace never leaves the app running; NotFound is zero.
              attempt(async () => {
                let ok = true;
                for (const w of state.workloadsToZero) {
                  try {
                    await kubectl(ip, [
                      '-n',
                      w.namespace,
                      'scale',
                      w.kind.toLowerCase(),
                      w.name,
                      '--replicas=0',
                    ]);
                  } catch (err) {
                    if (!NOT_FOUND.test(String(err?.message ?? err))) ok = false;
                  }
                }
                return ok;
              }),
      },
      {
        key: 'walgStandby',
        what: 'WALG_ROLE=standby',
        // demoteK8sWalgRole drops the retired side's inactive replication
        // slots first (nobody streams from them), then writes the role.
        apply: (ip) => attempt(() => demoteK8sWalgRole({ ip, kubectl, warn: () => {} })),
      },
    ],
    // The db pod was down or mid-roll: wait for it (bounded) before the second pass.
    settle: (ip) =>
      attempt(() =>
        kubectl(ip, k8sDbRolloutStatusArgv(DB_SETTLE_TIMEOUT_S), {
          timeout: (DB_SETTLE_TIMEOUT_S + 30) * 1000,
        }),
      ),
  };
}

// ---------------------------------------------------------------------------
// compose-ha: one ssh session per read, container names from container_name
// ---------------------------------------------------------------------------

const running = (ct) =>
  `[ "$(docker container inspect -f '{{.State.Running}}' ${ct} 2>/dev/null)" = true ]`;

/** One read of everything the compose fence covers; null when the node does not answer. */
async function probeCompose(ip, { run, projectName, writerContainers, psqlFor }) {
  const dbCt = `${projectName}-db`;
  const out = await run(
    ip,
    [
      `cd /opt/${projectName} || exit 1`,
      `if [ -f ${RETIRED_HOST_MARKER} ]; then echo HOST_MARKER=1; else echo HOST_MARKER=0; fi`,
      // The RUNNING container's env, not .env: a merged .env does nothing until
      // the db container is recreated.
      `echo "WALG_ROLE=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${dbCt} 2>/dev/null | sed -n 's/^WALG_ROLE=//p' | head -n1)"`,
      `if ${running(dbCt)}; then if docker exec ${dbCt} sh -c '[ -f ${DB_MARKER_PATH} ]'; then echo DB_MARKER=present; else echo DB_MARKER=absent; fi; else echo DB_MARKER=unknown; fi`,
      `for c in ${writerContainers.join(' ')}; do if ${running('"$c"')}; then echo "RUNNING $c"; fi; done`,
      'echo PROBE_DONE',
    ].join('\n'),
    { timeout: PROBE_TIMEOUT_MS },
  );
  const lines = String(out === false ? '' : (out ?? ''))
    .split('\n')
    .map((l) => l.trim());
  if (!lines.includes('PROBE_DONE')) return null;
  const value = (key) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  const dbMarker = value('DB_MARKER');
  const dbState = await probeDb(psqlFor(ip));
  return {
    marker: value('HOST_MARKER') === '1',
    dbMarker: dbMarker === 'present' ? true : dbMarker === 'absent' ? false : 'unknown',
    dbReadOnly: dbState.readOnly,
    walBytes: dbState.walBytes,
    workloadsZero: !lines.some((l) => l.startsWith('RUNNING ')),
    walgStandby: value('WALG_ROLE') === 'standby',
  };
}

function composeBackend({
  run,
  psqlFor,
  projectName,
  sshKeyPath,
  zeroWorkloads,
  demoteWalgRole,
  writerServices,
}) {
  const dbCt = `${projectName}-db`;
  const confirmed = async (ip, command) => {
    const out = await run(ip, `${command} && echo OK`, { timeout: 30_000 });
    return String(out === false ? '' : (out ?? '')).trim() === 'OK';
  };
  return {
    probe: async (ip) => {
      return probeCompose(ip, {
        run,
        projectName,
        psqlFor,
        writerContainers: writerServices.map((svc) => `${projectName}-${svc}`),
      });
    },
    // Marker first (it refuses the nightly backup), then the PGDATA marker (it
    // refuses WAL archiving at once), the database read-only, the writers
    // before the db recreate the role change needs (ALTER SYSTEM persists in
    // postgresql.auto.conf across it).
    steps: [
      {
        key: 'marker',
        what: `the ${RETIRED_HOST_MARKER} marker`,
        apply: (ip) => confirmed(ip, `touch /opt/${projectName}/${RETIRED_HOST_MARKER}`),
      },
      {
        key: 'dbMarker',
        what: 'the PGDATA marker',
        apply: (ip) =>
          confirmed(ip, `docker exec -u postgres ${dbCt} sh -c 'touch ${DB_MARKER_PATH}'`),
      },
      fenceDbStep(psqlFor),
      {
        key: 'workloadsZero',
        what: 'its writers stopped',
        apply: async (ip) => {
          if (zeroWorkloads) return zeroWorkloads(ip);
          const { stopOldPrimaryWriters } = await import('./compose/ha.js');
          return (await stopOldPrimaryWriters(ip, sshKeyPath, projectName, writerServices)).ok;
        },
      },
      {
        key: 'walgStandby',
        what: 'WALG_ROLE=standby',
        apply: async (ip) => {
          if (demoteWalgRole) return demoteWalgRole(ip);
          const { demoteComposeWalgRole } = await import('./compose/ha.js');
          return demoteComposeWalgRole({
            oldPrimaryIp: ip,
            sshKeyPath,
            projectName,
            deps: { log: () => {}, warn: () => {} },
          });
        },
      },
    ],
    // demoteComposeWalgRole's recreate already waits for the db to accept connections.
    settle: async () => true,
  };
}

async function backendFor(tier, { projectName, sshKeyPath, deps, envConfig }) {
  if (tier === 'k8s-ha') {
    return k8sBackend({
      kubectl: deps.kubectl ?? ((ip, argv, opts) => sshKubectl(ip, sshKeyPath, argv, opts)),
      psqlFor: deps.psql ?? ((ip) => k8sPsqlRunner(ip, sshKeyPath)),
      zeroWorkloads: deps.zeroWorkloads,
      workloads: k8sFencedWorkloads(),
    });
  }
  if (tier === 'compose-ha') {
    if (!envConfig) {
      throw new Error(
        'retired fence: the compose tier needs envConfig, whose enabled add-ons name the writers to fence',
      );
    }
    let psqlFor = deps.psql;
    if (!psqlFor) {
      const { composePsqlRunner } = await import('./compose/ha.js');
      psqlFor = (ip) => composePsqlRunner(ip, sshKeyPath, `/opt/${projectName}`);
    }
    return composeBackend({
      run: deps.run ?? ((ip, command, opts) => composeSshRun(ip, sshKeyPath, command, opts)),
      psqlFor,
      projectName,
      sshKeyPath,
      zeroWorkloads: deps.zeroWorkloads,
      demoteWalgRole: deps.demoteWalgRole,
      writerServices: composeWriterServices(enabledAddonNames(envConfig)),
    });
  }
  throw new Error(`retired fence: unknown tier ${JSON.stringify(tier)}`);
}

/**
 * Fence one retired node: read its state, apply only the missing parts. A part
 * the first read could not see (its db down or mid-roll) gets a second pass
 * once the db settles, so one run fences fully.
 *
 * `deps.zeroWorkloads(ip) -> Promise<boolean>` replaces the built-in writer
 * stop (k8s: the app Deployment and every declared add-on workload, the
 * pilot-standby list over all of services/; compose: the declared writers).
 *
 * @param {object} args
 * @param {'compose-ha'|'k8s-ha'} args.tier
 * @param {string} args.ip
 * @param {string} args.projectName
 * @param {string} args.sshKeyPath
 * @param {object} [args.envConfig] the env config, whose enabled add-ons name the compose writers
 * @param {object} [args.deps] kubectl / run / psql / zeroWorkloads / demoteWalgRole seams
 * @returns {Promise<{ reachable: boolean, fenced: boolean, wrote: string[], missing: string[], walBytes: number|null }>}
 */
export async function fenceRetiredNode({
  tier,
  ip,
  projectName,
  sshKeyPath,
  envConfig,
  deps = {},
}) {
  const backend = await backendFor(tier, { projectName, sshKeyPath, deps, envConfig });
  const state = await backend.probe(ip);
  if (!state) {
    return { reachable: false, fenced: false, wrote: [], missing: ['reachable'], walBytes: null };
  }
  const wrote = [];
  const failed = new Set();
  const pass = async () => {
    for (const step of backend.steps) {
      if (state[step.key] !== false || failed.has(step.key)) continue;
      if (await step.apply(ip, state)) {
        state[step.key] = true;
        wrote.push(step.what);
      } else {
        failed.add(step.key);
      }
    }
  };
  await pass();
  // Only a db-side part the first read could not see is worth the db settle
  // (a rollout wait): an unreadable Flux API is not helped by it.
  if (DB_KEYS.some((key) => state[key] === 'unknown')) {
    await backend.settle(ip);
    const again = await backend.probe(ip);
    if (again) {
      for (const step of backend.steps) {
        if (state[step.key] === 'unknown') state[step.key] = again[step.key];
      }
      state.fluxToSuspend = again.fluxToSuspend ?? state.fluxToSuspend;
      state.workloadsToZero = again.workloadsToZero ?? state.workloadsToZero;
      state.walBytes = state.walBytes ?? again.walBytes;
      await pass();
    }
  }
  const missing = backend.steps
    .filter((s) => state[s.key] !== true)
    .map((s) => (state[s.key] === 'unknown' ? `${s.what} (its db or API did not answer)` : s.what));
  return {
    reachable: true,
    fenced: missing.length === 0,
    wrote,
    missing,
    walBytes: state.walBytes,
  };
}

/**
 * Re-apply the retirement fence on every reachable side the persisted roles
 * call retired. Idempotent: an already fenced side gets reads only. Never
 * throws for a side it cannot reach or finish: it reports it, and the next
 * command that reaches it tries again.
 *
 * @param {object} args
 * @param {string} args.environment
 * @param {object} args.envConfig - the persisted env config (roles, lastFailover)
 * @param {{ projectName: string }} args.projectConfig
 * @param {'compose-ha'|'k8s-ha'} args.tier
 * @param {object} [args.deps] sshKeyPath / kubectl / run / psql / zeroWorkloads /
 *   demoteWalgRole / log / warn
 * @returns {Promise<{ fenced: string[], unreachable: string[], nodes: Array<{ ip: string, fenced: boolean, wrote: string[], walBytes: number|null }> }>}
 *   `unreachable` names every retired side not fully fenced (it, or its database, did not answer)
 */
export async function reconcileRetiredFence({
  environment,
  envConfig,
  projectConfig,
  tier,
  deps = {},
}) {
  const sides = retiredSides({ envConfig, tier });
  const result = { fenced: [], unreachable: [], nodes: [] };
  if (sides.length === 0) return result;
  const { log = (line) => p.log.info(line), warn = (line) => p.log.warn(line) } = deps;
  const sshKeyPath = deps.sshKeyPath ?? getSSHKeyPath(environment);
  const domain = envConfig?.domain || envConfig?.dns?.domain;
  for (const { ip } of sides) {
    const verdict = await fenceRetiredNode({
      tier,
      ip,
      projectName: projectConfig?.projectName,
      sshKeyPath,
      envConfig,
      deps,
    });
    result.nodes.push({
      ip,
      fenced: verdict.fenced,
      wrote: verdict.wrote,
      walBytes: verdict.walBytes,
    });
    if (verdict.fenced) {
      result.fenced.push(ip);
      if (verdict.wrote.length > 0) {
        log(
          `fenced the retired node ${ip} (${verdict.wrote.join(', ')}): it refuses backups and ` +
            'writes until vibecarbon deploy rebuilds it as the standby' +
            (domain
              ? `. if ${domain} still points at it, the site is down until its A records move to the primary`
              : ''),
        );
      }
      continue;
    }
    result.unreachable.push(ip);
    warn(
      verdict.reachable
        ? `the retired node ${ip} is only partly fenced (missing: ${verdict.missing.join(', ')}); ` +
            'the next status, failover or deploy that reaches it tries again'
        : `the retired node ${ip} does not answer, so it is not fenced yet; the next status, ` +
            'failover or deploy that reaches it fences it before it can push a backup',
    );
  }
  return result;
}

/**
 * Take the fence off a retired side that has just been rebuilt as a proven
 * replica. It first proves it: the side must read pg_is_in_recovery() = true.
 * Otherwise (a degraded deploy that never reseeded it, or a db that does not
 * answer) nothing is touched, one warning line says the fence is kept, and it
 * returns `{ cleared: false }` so the caller keeps the env swapped and the next
 * deploy retries. A stale ex-primary must never be made writable or handed
 * back to Flux. Once proven, it removes both markers, the database-level read-only setting from its
 * settings files (a later promotion must never come up read-only), and, on
 * k8s, the Flux Kustomizations the fence suspended. Throws a one-line cause
 * when it cannot prove all of it: a marker left behind would make that node
 * refuse its own backups once a later failover promotes it, so the caller must
 * not record the rebuild as complete.
 *
 * @param {object} args
 * @param {'compose-ha'|'k8s-ha'} args.tier
 * @param {string} args.ip
 * @param {string} args.projectName
 * @param {string} [args.environment]
 * @param {object} [args.deps] sshKeyPath / kubectl / run / psql / warn seams
 * @returns {Promise<{ cleared: boolean }>}
 */
export async function clearRetiredFence({ tier, ip, projectName, environment, deps = {} }) {
  const sshKeyPath = deps.sshKeyPath ?? getSSHKeyPath(environment);
  const { warn = (line) => p.log.warn(line) } = deps;
  let psqlFor = deps.psql;
  if (!psqlFor && tier === 'k8s-ha') psqlFor = (h) => k8sPsqlRunner(h, sshKeyPath);
  if (!psqlFor && tier === 'compose-ha') {
    const { composePsqlRunner } = await import('./compose/ha.js');
    psqlFor = (h) => composePsqlRunner(h, sshKeyPath, `/opt/${projectName}`);
  }
  const exec = psqlFor ? psqlFor(ip) : null;
  let replica = false;
  try {
    replica = String((await exec?.('SELECT pg_is_in_recovery()')) ?? '').trim() === 't';
  } catch {
    replica = false;
  }
  if (!replica) {
    warn(
      `retired side not yet a replica; fence kept (${ip}): the next vibecarbon deploy retries ` +
        'once it streams from the primary',
    );
    return { cleared: false };
  }
  const fail = (why) =>
    new Error(
      `could not clear the retired marker on the rebuilt standby ${ip} (${why}); ` +
        'rerun vibecarbon deploy to finish',
    );
  const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
  if (tier === 'k8s-ha') {
    const kubectl = deps.kubectl ?? ((h, argv, opts) => sshKubectl(h, sshKeyPath, argv, opts));
    try {
      // A merge-patch null removes the key, and is a no-op when it is absent.
      await kubectl(ip, [
        '-n',
        NS,
        'patch',
        'configmap',
        'vibecarbon-config',
        '--type=merge',
        '-p',
        JSON.stringify({ data: { [RETIRED_ROLE_KEY]: null } }),
      ]);
      const out = await kubectl(ip, k8sDbMarkerExec(`rm -f ${DB_MARKER_PATH} && echo OK`));
      if (String(out ?? '').trim() !== 'OK') throw new Error('rm did not confirm');
      await clearDbReadOnly(exec);
      for (const k of (await listFluxKustomizations(ip, kubectl)) ?? []) {
        if (k?.metadata?.annotations?.[FLUX_SUSPENDED_BY] !== FLUX_SUSPENDED_BY_VALUE) continue;
        await kubectl(ip, [
          '-n',
          FLUX_NS,
          'patch',
          FLUX_KUSTOMIZATION,
          k.metadata.name,
          '--type=merge',
          '-p',
          fluxPatch(false),
        ]);
      }
    } catch (err) {
      throw fail(firstLine(err));
    }
    return { cleared: true };
  }
  if (tier === 'compose-ha') {
    const run = deps.run ?? ((h, command, opts) => composeSshRun(h, sshKeyPath, command, opts));
    const out = await run(
      ip,
      `rm -f /opt/${projectName}/${RETIRED_HOST_MARKER} && ` +
        `docker exec -u postgres ${projectName}-db sh -c 'rm -f ${DB_MARKER_PATH}' && echo CLEARED`,
      { timeout: 30_000 },
    );
    if (String(out === false ? '' : (out ?? '')).trim() !== 'CLEARED') {
      throw fail('the node or its db did not answer');
    }
    try {
      await clearDbReadOnly(exec);
    } catch (err) {
      throw fail(firstLine(err));
    }
    return { cleared: true };
  }
  throw new Error(`retired fence: unknown tier ${JSON.stringify(tier)}`);
}
