/**
 * Self-enforcing retirement (HA-correctness Task 6, R7).
 *
 * A failover often finishes with the old primary unreachable: that is usually
 * why it ran. Nothing then demoted it, so when it comes back it still believes
 * it is the primary. Its app serves stale data to any client on old DNS, its
 * archive_command pushes WAL into the backup prefix the new primary owns, and
 * its nightly base backup does too, ending in a `wal-g delete retain` that can
 * prune the new primary's backups. Until a deploy rebuilds it as the standby,
 * the side the persisted roles call retired is fenced by markers it enforces
 * itself:
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
 * Besides the markers the fence holds the retired side's writers at zero (k8s:
 * `kubectl scale deployment app --replicas=0`, never a patch that would roll
 * pods; compose: the planned-failover writer set, app, n8n and metabase) and
 * WALG_ROLE=standby.
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
 * retired-fence-entrypoints census pins both).
 */

import * as p from '@clack/prompts';
import { getSSHKeyPath, sshKubectl } from '../ssh.js';
import { sshRun as composeSshRun } from './compose/index.js';
import { DB_CONTAINER, DB_POD, DB_STATEFULSET } from './db-workload.js';
import { swappedSinceLastDeploy } from './failover-guard.js';
import { k8sSetWalgRoleArgv } from './walg-role.js';

/** The vibecarbon-config key the k8s backup CronJob reads. */
export const RETIRED_ROLE_KEY = 'VIBECARBON_ROLE';
export const RETIRED_ROLE = 'retired';
/** compose: `<remoteDir>/.vibecarbon-retired`, checked by compose-backup.sh. */
export const RETIRED_HOST_MARKER = '.vibecarbon-retired';
/** both tiers: `$PGDATA/vibecarbon-retired`, checked by wal-archive.sh. */
export const RETIRED_DB_MARKER = 'vibecarbon-retired';
/** The one line every backup script prints when it refuses. */
export const RETIRED_REFUSAL = 'retired node: backups refused';

/** The app Deployment the k8s fence zeroes (k8s/base/app/deployment.yaml). */
const K8S_APP_DEPLOYMENT = 'app';
const NS = 'vibecarbon';
/** PGDATA as the db container resolves it (the image sets PGDATA). */
const DB_MARKER_PATH = `"\${PGDATA:-/var/lib/postgresql/data}/${RETIRED_DB_MARKER}"`;
/** Reads are bounded: status calls this, and an unreachable side must not stall it. */
const PROBE_TIMEOUT_MS = 20_000;

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

/** One read of everything the k8s fence covers; null when the cluster does not answer. */
async function probeK8s(ip, kubectl) {
  let listed;
  try {
    listed = JSON.parse(
      await kubectl(
        ip,
        [
          '-n',
          NS,
          'get',
          'configmap/vibecarbon-config',
          `deployment/${K8S_APP_DEPLOYMENT}`,
          `statefulset/${DB_STATEFULSET}`,
          '-o',
          'json',
          '--ignore-not-found',
        ],
        { timeout: PROBE_TIMEOUT_MS, transportRetry: false },
      ),
    );
  } catch {
    return null;
  }
  const items = listed?.kind === 'List' ? (listed.items ?? []) : [listed];
  const of = (kind) => items.find((i) => i?.kind === kind);
  const dep = of('Deployment');
  const db = (of('StatefulSet')?.spec?.template?.spec?.containers ?? []).find(
    (ct) => ct.name === DB_CONTAINER,
  );
  let dbMarker = 'unknown';
  try {
    const out = await kubectl(
      ip,
      k8sDbMarkerExec(`if [ -f ${DB_MARKER_PATH} ]; then echo present; else echo absent; fi`),
      { timeout: PROBE_TIMEOUT_MS, transportRetry: false },
    );
    const v = String(out ?? '').trim();
    if (v === 'present' || v === 'absent') dbMarker = v;
  } catch {
    // db pod not running: placed after the role roll, or left to the next run.
  }
  return {
    marker: of('ConfigMap')?.data?.[RETIRED_ROLE_KEY] === RETIRED_ROLE,
    dbMarker,
    workloadsZero: !dep || dep.spec?.replicas === 0,
    walgStandby: (db?.env ?? []).find((e) => e.name === 'WALG_ROLE')?.value === 'standby',
  };
}

function k8sBackend({ kubectl, zeroWorkloads }) {
  const attempt = async (fn) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };
  const placeDbMarker = (ip) =>
    attempt(async () => {
      const out = await kubectl(ip, k8sDbMarkerExec(`touch ${DB_MARKER_PATH} && echo OK`));
      if (String(out ?? '').trim() !== 'OK') throw new Error('touch did not confirm');
    });
  return {
    probe: (ip) => probeK8s(ip, kubectl),
    // Ordered so the backups are refused first, and the db marker lands
    // before the WALG_ROLE change rolls the db pod.
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
        when: (s) => s.dbMarker === 'absent',
        apply: placeDbMarker,
      },
      {
        key: 'workloadsZero',
        what: 'its app at zero',
        apply: (ip) =>
          zeroWorkloads
            ? zeroWorkloads(ip)
            : // kubectl scale, never a patch or set image: those would roll pods.
              attempt(() =>
                kubectl(ip, ['-n', NS, 'scale', 'deployment', K8S_APP_DEPLOYMENT, '--replicas=0']),
              ),
      },
      {
        key: 'walgStandby',
        what: 'WALG_ROLE=standby',
        apply: (ip) =>
          attempt(() => kubectl(ip, k8sSetWalgRoleArgv('standby'), { timeout: 60_000 })),
      },
    ],
    // The db pod was down at the probe: try the marker once more after the roll.
    lateDbMarker: placeDbMarker,
  };
}

// ---------------------------------------------------------------------------
// compose-ha: one ssh session per read, container names from container_name
// ---------------------------------------------------------------------------

const running = (ct) =>
  `[ "$(docker container inspect -f '{{.State.Running}}' ${ct} 2>/dev/null)" = true ]`;

/** One read of everything the compose fence covers; null when the node does not answer. */
async function probeCompose(ip, { run, projectName, writerContainers }) {
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
  return {
    marker: value('HOST_MARKER') === '1',
    dbMarker: dbMarker === 'present' || dbMarker === 'absent' ? dbMarker : 'unknown',
    workloadsZero: !lines.some((l) => l.startsWith('RUNNING ')),
    walgStandby: value('WALG_ROLE') === 'standby',
  };
}

function composeBackend({ run, projectName, sshKeyPath, zeroWorkloads, demoteWalgRole }) {
  const dbCt = `${projectName}-db`;
  const confirmed = async (ip, command) => {
    const out = await run(ip, `${command} && echo OK`, { timeout: 30_000 });
    return String(out === false ? '' : (out ?? '')).trim() === 'OK';
  };
  const placeDbMarker = (ip) =>
    confirmed(ip, `docker exec -u postgres ${dbCt} sh -c 'touch ${DB_MARKER_PATH}'`);
  return {
    probe: async (ip) => {
      const { FAILOVER_FENCE_SERVICES } = await import('./compose/ha.js');
      return probeCompose(ip, {
        run,
        projectName,
        writerContainers: FAILOVER_FENCE_SERVICES.map((svc) => `${projectName}-${svc}`),
      });
    },
    // Marker first (it refuses the nightly backup), then the PGDATA marker (it
    // refuses WAL archiving at once), the writers before the db recreate the
    // role change needs.
    steps: [
      {
        key: 'marker',
        what: `the ${RETIRED_HOST_MARKER} marker`,
        apply: (ip) => confirmed(ip, `touch /opt/${projectName}/${RETIRED_HOST_MARKER}`),
      },
      {
        key: 'dbMarker',
        what: 'the PGDATA marker',
        when: (s) => s.dbMarker === 'absent',
        apply: placeDbMarker,
      },
      {
        key: 'workloadsZero',
        what: 'its writers stopped',
        apply: async (ip) => {
          if (zeroWorkloads) return zeroWorkloads(ip);
          const { stopOldPrimaryWriters } = await import('./compose/ha.js');
          return (await stopOldPrimaryWriters(ip, sshKeyPath, projectName)).ok;
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
    // The db was down at the probe: the role recreate above brought it up.
    lateDbMarker: placeDbMarker,
  };
}

function backendFor(tier, { projectName, sshKeyPath, deps }) {
  if (tier === 'k8s-ha') {
    return k8sBackend({
      kubectl: deps.kubectl ?? ((ip, argv, opts) => sshKubectl(ip, sshKeyPath, argv, opts)),
      zeroWorkloads: deps.zeroWorkloads,
    });
  }
  if (tier === 'compose-ha') {
    return composeBackend({
      run: deps.run ?? ((ip, command, opts) => composeSshRun(ip, sshKeyPath, command, opts)),
      projectName,
      sshKeyPath,
      zeroWorkloads: deps.zeroWorkloads,
      demoteWalgRole: deps.demoteWalgRole,
    });
  }
  throw new Error(`retired fence: unknown tier ${JSON.stringify(tier)}`);
}

/**
 * Fence one retired node: read its state, apply only the missing parts.
 *
 * `deps.zeroWorkloads(ip) -> Promise<boolean>` replaces the built-in writer
 * stop (k8s: the app Deployment; compose: app, n8n, metabase). It is the seam
 * the primary-only add-ons plan fills with zeroWorkloadsOnStandby.
 *
 * @param {object} args
 * @param {'compose-ha'|'k8s-ha'} args.tier
 * @param {string} args.ip
 * @param {string} args.projectName
 * @param {string} args.sshKeyPath
 * @param {object} [args.deps] kubectl / run / zeroWorkloads / demoteWalgRole seams
 * @returns {Promise<{ reachable: boolean, fenced: boolean, wrote: string[], missing: string[] }>}
 */
export async function fenceRetiredNode({ tier, ip, projectName, sshKeyPath, deps = {} }) {
  const backend = backendFor(tier, { projectName, sshKeyPath, deps });
  const state = await backend.probe(ip);
  if (!state) return { reachable: false, fenced: false, wrote: [], missing: ['reachable'] };
  const wrote = [];
  const missing = [];
  for (const step of backend.steps) {
    const needed = step.when ? step.when(state) : !state[step.key];
    if (!needed) continue;
    if (await step.apply(ip)) {
      state[step.key] = step.key === 'dbMarker' ? 'present' : true;
      wrote.push(step.what);
    } else {
      missing.push(step.what);
    }
  }
  if (state.dbMarker === 'unknown') {
    if (await backend.lateDbMarker(ip)) {
      state.dbMarker = 'present';
      wrote.push('the PGDATA marker');
    } else {
      missing.push('the PGDATA marker (its db is not running)');
    }
  }
  return { reachable: true, fenced: missing.length === 0, wrote, missing };
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
 * @param {object} [args.deps] sshKeyPath / kubectl / run / zeroWorkloads /
 *   demoteWalgRole / log / warn
 * @returns {Promise<{ fenced: string[], unreachable: string[] }>} `unreachable`
 *   names every retired side not fully fenced (it, or its database, did not answer)
 */
export async function reconcileRetiredFence({
  environment,
  envConfig,
  projectConfig,
  tier,
  deps = {},
}) {
  const sides = retiredSides({ envConfig, tier });
  const result = { fenced: [], unreachable: [] };
  if (sides.length === 0) return result;
  const { log = (line) => p.log.info(line), warn = (line) => p.log.warn(line) } = deps;
  const sshKeyPath = deps.sshKeyPath ?? getSSHKeyPath(environment);
  for (const { ip } of sides) {
    const verdict = await fenceRetiredNode({
      tier,
      ip,
      projectName: projectConfig?.projectName,
      sshKeyPath,
      deps,
    });
    if (verdict.fenced) {
      result.fenced.push(ip);
      if (verdict.wrote.length > 0) {
        log(
          `fenced the retired node ${ip} (${verdict.wrote.join(', ')}): it refuses backups and ` +
            'serves nothing until vibecarbon deploy rebuilds it as the standby',
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
 * replica. Throws a one-line cause when it cannot prove both markers gone: a
 * marker left behind would make that node refuse its own backups once a later
 * failover promotes it, so the caller must not record the rebuild as complete.
 *
 * @param {object} args
 * @param {'compose-ha'|'k8s-ha'} args.tier
 * @param {string} args.ip
 * @param {string} args.projectName
 * @param {object} [args.deps] sshKeyPath / kubectl / run seams
 */
export async function clearRetiredFence({ tier, ip, projectName, environment, deps = {} }) {
  const sshKeyPath = deps.sshKeyPath ?? getSSHKeyPath(environment);
  const fail = (why) =>
    new Error(
      `could not clear the retired marker on the rebuilt standby ${ip} (${why}); ` +
        'rerun vibecarbon deploy to finish',
    );
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
    } catch (err) {
      throw fail(String(err?.message ?? err).split('\n')[0]);
    }
    return;
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
    return;
  }
  throw new Error(`retired fence: unknown tier ${JSON.stringify(tier)}`);
}
