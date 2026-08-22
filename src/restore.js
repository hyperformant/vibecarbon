/**
 * Vibecarbon Restore Command
 *
 * Interactive-by-default. Bare `vibecarbon restore` walks the operator
 * through env selection → source selection → confirm → restore.
 * Positional and flag seeds skip the corresponding prompt. `-l` lists
 * available backups for an env without restoring (the read-only path
 * that was missing from the old CLI).
 *
 * `-source <name-or-path>` subsumes the old `--file` / `--from-s3` split:
 * if the value resolves to an existing local file, treat it as a local
 * upload-and-restore; otherwise validate as an S3 backup name and
 * restore from S3.
 *
 * Form rule: vibecarbon uses single-dash flags only — see
 * memory:feedback_cli_single_dash_flags.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import * as p from '@clack/prompts';
import { identifyServers } from './failover.js';
import { formatInstant } from './lib/backup-format.js';
import { resolveEnvContext } from './lib/cli/env-context.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
// Static imports (no cycle: neither compose/index.js nor compose/ha.js imports
// restore.js). Aliased so runComposeRestore can default to the real functions
// while still accepting injected mocks for unit tests.
import { configureStandbyReplication as realConfigureStandbyReplication } from './lib/deploy/compose/ha.js';
import { composeHaStandbyResyncHint } from './lib/deploy/compose/ha-role-swap.js';
import { restoreCompose as realRestoreCompose } from './lib/deploy/compose/index.js';
import {
  ensureReplicationSlot as realEnsureReplicationSlot,
  readK8sReplicationState as realReadK8sReplicationState,
  reseedStandbyFromPrimary as realReseedStandbyFromPrimary,
  verifyStreaming,
} from './lib/deploy/replication.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { perfAsync } from './lib/perf.js';
import { confirmProdOrExit } from './lib/prod-confirm.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import { getPostgresPod, getSSHKeyPath, sshKubectl } from './lib/ssh.js';
import { createTracker } from './lib/tracker.js';
import { validateBackupFilename } from './lib/validators.js';
import { listWalgBackups, printWalgBackupList } from './lib/walg-backups.js';

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'restore',
  summary: 'Restore a database from a backup',
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to restore (skips the env prompt)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompts' },
    {
      name: 'l',
      boolean: true,
      description: 'List available backups (read-only; does not restore)',
    },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'source',
      value: '<latest|ISO-timestamp|file>',
      description: 'Restore point: `latest`, an ISO-8601 timestamp (PITR), or a local file path',
    },
  ],
  examples: [
    { command: 'vibecarbon restore', description: 'prompts for env and restore point' },
    { command: 'vibecarbon restore prod -l', description: 'list available backups for prod' },
    {
      command: 'vibecarbon restore prod -y -source latest',
      description: 'restore the most-recent backup, non-interactively',
    },
    {
      command: 'vibecarbon restore prod -source 2026-06-22T14:30:00Z',
      description: 'point-in-time recovery to a specific moment (wal-g WAL replay)',
    },
    {
      command: 'vibecarbon restore prod -source ./backup.tar.gz -y',
      description: 'restore from a local file, skipping confirmation',
    },
  ],
};

// ============================================================================
// RESTORE OPERATIONS (k8s mode)
// ============================================================================

async function scaleDownApp(ip, sshKeyPath) {
  await sshKubectl(ip, sshKeyPath, [
    'scale',
    'deployment',
    'app',
    '-n',
    'vibecarbon',
    '--replicas=0',
  ]);

  try {
    await sshKubectl(ip, sshKeyPath, [
      'rollout',
      'status',
      'deployment/app',
      '-n',
      'vibecarbon',
      '--timeout=60s',
    ]);
  } catch {
    // Continue even if timeout
  }
}

async function scaleUpApp(ip, sshKeyPath) {
  await sshKubectl(ip, sshKeyPath, [
    'scale',
    'deployment',
    'app',
    '-n',
    'vibecarbon',
    '--replicas=2',
  ]);
}

/**
 * Wait until postgres on the db pod is actually accepting connections.
 *
 * After a wal-g restore, postgres replays archived WAL (restore_command) before
 * promoting — minutes on a busy DB (observed 112s). The pod can be Ready while
 * postgres is still "not accepting connections", so a single pg_isready races
 * slow replay and reports a false restore failure. Poll until it accepts (or
 * give up after `timeoutMs`).
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=300000]
 * @param {number} [opts.intervalMs=2000]
 * @param {(ip: string, key: string, args: string[]) => unknown} [opts.exec=sshKubectl]
 * @param {(ip: string, key: string) => string} [opts.getPod=getPostgresPod]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export async function verifyPostgres(ip, sshKeyPath, opts = {}) {
  const {
    timeoutMs = 300_000,
    // 2s (not 5s): this is the granularity of the tail between "postgres
    // finished WAL replay + promoted" and "we observe it". 5s was needlessly
    // coarse; halving it tightens the tail without touching the early-exit
    // (first successful pg_isready returns) or the 300s timeoutMs ceiling.
    intervalMs = 2_000,
    exec = sshKubectl,
    getPod = getPostgresPod,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const pod = await getPod(ip, sshKeyPath);
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  for (;;) {
    try {
      await exec(ip, sshKeyPath, [
        'exec',
        '-n',
        'vibecarbon',
        pod,
        '--',
        'pg_isready',
        '-U',
        'postgres',
      ]);
      return; // exit 0 = accepting connections
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `verifyPostgres: postgres did not accept connections within ${Math.round(timeoutMs / 1000)}s ` +
          `(still replaying WAL after a wal-g restore?). Last pg_isready error: ${lastErr}`,
      );
    }
    await sleep(intervalMs);
  }
}

// (k8s pg_dump restore helpers removed — k8s restore is now wal-g-native via
// the db pod's init container; see runK8sRestore below.)

// ============================================================================
// SOURCE INTERPRETATION
// ============================================================================

/**
 * The `-source` flag accepts either a local file path or an S3 backup
 * name. Existence on disk is the signal: if the value resolves to a
 * file we treat it as upload-and-restore; otherwise we validate as an
 * S3 backup name and restore from S3.
 *
 * @param {string} source
 * @returns {{ kind: 'local', path: string, name: string } | { kind: 's3', name: string }}
 */
function classifySource(source) {
  if (existsSync(source)) {
    return { kind: 'local', path: source, name: basename(source) };
  }
  // Not a local path — assume S3 backup name. Validate format up front
  // so downstream code can trust it.
  const err = validateBackupFilename(source);
  if (err) {
    p.log.error(`Invalid -source: ${err}`);
    p.log.info(
      `Expected a local file path or S3 backup name (e.g. myapp_20260507_120000_full.tar.gz)`,
    );
    process.exit(1);
  }
  return { kind: 's3', name: source };
}

// ============================================================================
// MAIN
// ============================================================================

export async function run(args) {
  const { values, positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Project guard runs before banner so an accidental `vibecarbon
  // restore` from a parent directory emits the canonical message.
  const projectConfig = assertInProjectDir();

  introCommand('restore');

  // Source-prompt requirements gate after the env is resolved (since the
  // picker depends on which backups exist for the env). serverIp: 'primary' —
  // this same serverIp feeds both the restore target and (in
  // runComposeRestore) the re-seed source, so they stay consistent with the
  // standby selection.
  const { envName, envConfig, serverIp } = await resolveEnvContext({
    command: 'restore',
    actionVerb: 'restore',
    envRequirement: 'name an environment to restore',
    values,
    positional,
    projectConfig,
    serverIp: 'primary',
  });

  // Source TTY guard fires *before* infrastructure checks so the
  // off-TTY error message is "needs -source" rather than "SSH key
  // not found" — the latter would correctly diagnose a different
  // problem but obscures what the operator actually needs to fix
  // for a scripted invocation.
  if (!values.l && !values.source) {
    requireTTYOrFlags({
      requirements: [
        {
          flag: 'source',
          description: 'name the backup to restore (S3 name or local file path)',
          satisfied: false,
        },
      ],
    });
  }

  // Operator-IP firewall refresh — the listing path needs SSH/k8s
  // reachability too (we may fall back to a pod-list when S3 isn't
  // configured), so we run this regardless of -l.
  const apiToken = resolveProviderToken(providerIdFor(envConfig));
  if (apiToken) {
    try {
      const isHA = envConfig.deployMode === 'compose-ha' || !!envConfig.ha?.enabled;
      const result = await ensureOperatorIpAccess({
        projectConfig,
        environment: envName,
        isHA,
        apiToken,
        yes: !!values.y,
        onMessage: (msg) => p.log.info(msg),
      });
      if (result.added) {
        p.log.success(`Firewall updated: SSH/k8s API now allow ${result.cidr}`);
      }
    } catch (err) {
      p.log.error(`Operator-IP check failed: ${err.message}`);
      process.exit(1);
    }
  }

  // SSH key is required for everything restore touches.
  const sshKeyPath = getSSHKeyPath(envName);
  if (!existsSync(sshKeyPath)) {
    p.log.error(`SSH key not found: ${sshKeyPath}`);
    p.log.info(
      'The deployment key is created during deploy and is required for restore operations.',
    );
    process.exit(1);
  }

  const projectName = projectConfig.projectName || 'project';
  const isCompose = envConfig.deployMode === 'compose' || envConfig.deployMode === 'compose-ha';

  // -l: list-only path. Read-only; print and exit.
  if (values.l) {
    await runList({ isCompose, envName, projectName, serverIp, sshKeyPath });
    p.outro('');
    return;
  }

  // Resolve the chosen backup source. Restore is wal-g-native (compose + k8s):
  // wal-g runs server-side and reads its own S3 config from the db container —
  // the operator does NOT need local S3 credentials to restore.
  //
  // `-source latest` (e2e, post-incident scripts) and `-y` both resolve to the
  // LATEST base backup; `-source <ISO-8601>` is a point-in-time target. A bare
  // interactive run opens the restore-point chooser.
  const wantsLatest = values.source === 'latest';
  let chosenSource;
  if (!wantsLatest && values.source) {
    chosenSource = classifySource(/** @type {string} */ (values.source));
  } else if (wantsLatest) {
    chosenSource = { kind: 's3', name: 'latest' };
  } else {
    chosenSource = await pickInteractiveSource({
      isCompose,
      envName,
      projectName,
      serverIp,
      sshKeyPath,
      yes: !!values.y,
    });
  }

  if (!chosenSource) {
    p.log.error('No backup selected.');
    process.exit(1);
  }

  // Confirmation gates
  p.log.warn('This will overwrite the current database!');
  p.log.message(`  ${c.dim('Environment'.padEnd(14))} ${c.bold(envName)}`);
  p.log.message(`  ${c.dim('Server'.padEnd(14))} ${c.bold(serverIp)}`);
  p.log.message(`  ${c.dim('Backup'.padEnd(14))} ${c.bold(chosenSource.name)}`);

  if (!values.y) {
    const confirm = await p.confirm({
      message: `Restore ${c.bold(chosenSource.name)} to ${c.bold(envName)}?`,
    });
    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(confirm)) {
      exitCancelled();
    }
    if (!confirm) {
      exitDeclined();
    }
  }

  // SECURITY: the production type-to-confirm runs UNCONDITIONALLY — even with
  // -y — so `restore -y prod` can never silently overwrite the production
  // database. This is deliberately OUTSIDE the `!values.y` block above (the
  // soft y/N confirm is skippable with -y; this hard gate is not). Mirrors
  // destroy's prod guard; shared helper so failover can reuse it.
  await confirmProdOrExit(envName, { actionLabel: 'restore', yes: !!values.y });

  // Dispatch by mode
  const tracker = createTracker('restore', { environment: envName });
  const s = tracker.spinner();

  try {
    if (isCompose) {
      await runComposeRestore({
        s,
        chosenSource,
        envName,
        projectName,
        serverIp,
        sshKeyPath,
        envConfig,
      });
    } else {
      await runK8sRestore({
        s,
        chosenSource,
        envName,
        serverIp,
        sshKeyPath,
        envConfig,
      });
    }
  } catch (error) {
    s.stop('Restore failed');
    p.log.error(error.message);
    if (!isCompose) {
      p.log.warn('The app deployment may need to be manually scaled back up:');
      p.log.info(
        `  ssh root@${serverIp} "kubectl scale deployment app -n vibecarbon --replicas=2"`,
      );
    }
    process.exit(1);
  }

  tracker.finish();
  p.outro(c.success('Done'));
}

// ============================================================================
// ORCHESTRATION HELPERS
// ============================================================================

async function runList({ isCompose, envName, projectName, serverIp, sshKeyPath }) {
  await printWalgBackupList({ serverIp, sshKeyPath, projectName, isCompose, envName });
}

// ISO-8601 datetime for point-in-time recovery. MUST stay in sync with
// composeRestoreScript's ISO_DATETIME_RE (compose/index.js) and the k8s
// walg-restore init container, which reject any other target format.
const RESTORE_PITR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

async function pickInteractiveSource({
  isCompose,
  envName,
  projectName,
  serverIp,
  sshKeyPath,
  yes,
}) {
  // Restore is wal-g-native for both compose and k8s: it ALWAYS fetches the
  // LATEST base backup and replays WAL — either to the present ("latest") or to
  // a point-in-time target. There is no "restore a specific older base backup",
  // so this is a restore-POINT chooser, not a backup-file picker. (The legacy
  // backups/*_full.tar.gz S3 objects are NOT wal-g backups — composeRestoreScript
  // and the k8s walg-restore init container reject any target that isn't
  // "latest" or an ISO-8601 datetime.)
  if (yes) {
    return { kind: 's3', name: 'latest' };
  }

  // Best-effort recovery-window context so point-in-time is meaningful. Never
  // blocks the chooser: if wal-g listing fails (db down, no --json), omit it.
  const tracker = createTracker('restore.window', { environment: envName });
  const s = tracker.spinner();
  s.start('Reading available backups');
  const backups = await listWalgBackups({ serverIp, sshKeyPath, projectName, isCompose });
  if (backups.length > 0) {
    const newest = formatInstant(backups[0].time);
    const oldest = formatInstant(backups[backups.length - 1].time);
    s.stop(
      backups.length === 1
        ? `1 base backup available (${newest})`
        : `${backups.length} base backups; recovery window ${oldest} → ${newest}`,
    );
  } else {
    s.stop('Backups read');
  }

  const choice = await p.select({
    message: 'Restore point:',
    options: [
      { value: 'latest', label: 'Latest', hint: 'most recent backup + all WAL (recommended)' },
      { value: 'pitr', label: 'Point in time…', hint: 'recover to a specific timestamp' },
    ],
  });
  if (p.isCancel(choice)) {
    exitCancelled();
  }
  if (choice === 'latest') {
    return { kind: 's3', name: 'latest' };
  }

  // Point-in-time: wal-g fetches the latest base backup and replays WAL up to
  // this instant. Must match the ISO-8601 target validation in
  // composeRestoreScript / the k8s walg-restore init container.
  const ts = await p.text({
    message: 'Recover to (ISO-8601 timestamp):',
    placeholder: '2026-06-22T14:30:00Z',
    validate: (v) =>
      RESTORE_PITR_RE.test((v || '').trim())
        ? undefined
        : 'Enter an ISO-8601 datetime, e.g. 2026-06-22T14:30:00Z',
  });
  if (p.isCancel(ts)) {
    exitCancelled();
  }
  return { kind: 's3', name: /** @type {string} */ (ts).trim() };
}

// compose restore is wal-g-based (S3 pull, no file transfer). Mirrors
// runK8sRestore's structure: reject local-file sources, resolve target,
// call restoreCompose, verify postgres.
//
// COMPOSE-HA re-seed (Invariant 3): the wal-g restore rewinds the PRIMARY
// (servers[0]) to an earlier LSN. For a compose-ha deployment the standby then
// has WAL *ahead* of the restored primary (streamed from the old primary) and
// cannot resume streaming — PostgreSQL would reject it with "requested timeline
// does not contain minimum recovery point" (timeline divergence). So after the
// primary promotes we re-seed the standby with a fresh pg_basebackup from the
// restored primary via configureStandbyReplication, which is destructive-by-
// design (it wipes the standby's PGDATA and re-basebackups — exactly what we
// want here). Single-region compose has no standby, so the re-seed is skipped.
//
// restoreCompose + configureStandbyReplication are injectable so the dispatch
// logic is unit-testable without SSH; production passes neither and they resolve
// to the real module functions (static imports — no cycle: ha.js/compose-index
// do not import restore.js).
export async function runComposeRestore({
  s,
  chosenSource,
  envName,
  projectName,
  serverIp,
  sshKeyPath,
  envConfig = {},
  restoreCompose = realRestoreCompose,
  configureStandbyReplication = realConfigureStandbyReplication,
}) {
  if (chosenSource.kind === 'local') {
    throw new Error(
      'compose restore is wal-g-based and pulls from S3, local backup files are not supported. ' +
        'Use `-source latest` or an ISO-8601 timestamp for PITR.',
    );
  }

  // wal-g target: 'latest' → LATEST base backup; otherwise treat the source
  // name as an ISO-8601 timestamp for point-in-time recovery.
  const target =
    chosenSource.name === 'latest' || !chosenSource.name ? 'latest' : chosenSource.name;

  s.start('Restoring database via wal-g (app will be temporarily unavailable)');
  await restoreCompose(serverIp, sshKeyPath, projectName, target);
  s.stop('Database restored');

  // compose-ha: the wal-g restore rewound the primary to an earlier LSN, so the
  // standby now has WAL AHEAD of the primary and cannot resume streaming. Re-seed
  // it with a fresh pg_basebackup from the restored primary so it rejoins the new
  // timeline. (configureStandbyReplication is destructive-by-design: it wipes the
  // standby's PGDATA and re-basebackups — exactly what we want here.)
  //
  // A re-seed failure is NOT a restore failure: the primary is restored and
  // serving — only the standby is degraded. Warn (don't rethrow) so the restore
  // still reports success. `deploy` is the resync — but only for an environment
  // whose roles still match its Pulumi stacks; on a failed-over one deploy
  // refuses, so the hint is rendered by composeHaStandbyResyncHint rather than
  // hard-coded (compose/ha-role-swap.js).
  if (envConfig.deployMode === 'compose-ha') {
    const standby = envConfig.servers?.find((sv) => sv.role === 'standby');
    if (standby?.ip) {
      try {
        s.start('Re-seeding standby from restored primary (pg_basebackup)');
        await configureStandbyReplication(standby.ip, serverIp, sshKeyPath, projectName);
        s.stop('Standby re-seeded from restored primary');
      } catch (err) {
        s.stop('Standby re-seed failed');
        p.log.warn(
          `Primary restored and serving, but standby re-seed failed: ${err.message}. ` +
            composeHaStandbyResyncHint({ projectName, environment: envName, envConfig }),
        );
      }
    } else {
      p.log.warn(
        'compose-ha restore: no standby server found to re-seed, skipping (verify replication manually).',
      );
    }
  }

  p.log.success('Restore completed successfully');
  p.log.info(`Verify with: ${c.info(`vibecarbon status ${envName}`)}`);
}

// k8s restore is wal-g-native: postgres + wal-g live in the supabase-db pod,
// which continuously archives WAL + base backups to S3. Restore = set a
// RESTORE_TARGET marker on vibecarbon-secrets → bounce the db StatefulSet so
// its walg-restore init container runs `wal-g backup-fetch` into PGDATA before
// postgres starts → clear the marker. No bytes flow through the operator and
// no pg_dump/kubectl-cp; wal-g pulls from S3 inside the cluster. Mirrors the
// compose wal-g restore, adapted to the StatefulSet/init-container shape.
const DB_STATEFULSET = 'supabase-supabase-db';

/** Set or clear the RESTORE_TARGET marker the init container reads. */
async function setRestoreMarker(ip, sshKeyPath, value) {
  await sshKubectl(ip, sshKeyPath, [
    'patch',
    'secret',
    'vibecarbon-secrets',
    '-n',
    'vibecarbon',
    '--type=merge',
    '-p',
    JSON.stringify({ stringData: { RESTORE_TARGET: value } }),
  ]);
}

export async function runK8sRestore({
  s,
  chosenSource,
  envName,
  serverIp,
  sshKeyPath,
  envConfig = {},
  // Injected so the k8s-HA standby re-seed dispatch is unit-testable without a
  // real cluster (mirrors runComposeRestore). Production passes none.
  reseedStandbyFromPrimary = realReseedStandbyFromPrimary,
  ensureReplicationSlot = realEnsureReplicationSlot,
  readReplicationState = realReadK8sReplicationState,
  // Pacing for the post-reseed streaming verify — injectable so tests don't wait
  // on real timers. Production uses the default setTimeout-backed sleep.
  verifySleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (chosenSource.kind === 'local') {
    throw new Error(
      'k8s restore is wal-g-based and pulls from S3 — local backup files are not supported. Use `-source latest` (or a timestamp for PITR).',
    );
  }
  // wal-g target: 'latest' → LATEST base backup; otherwise treat the source
  // name as an ISO-8601 timestamp for point-in-time recovery.
  const target =
    chosenSource.name === 'latest' || !chosenSource.name ? 'latest' : chosenSource.name;

  s.start('Restoring database via wal-g (app will be temporarily unavailable)');
  // 1. Mark the restore so the db pod's init container fetches on next boot.
  await setRestoreMarker(serverIp, sshKeyPath, target);
  // 2. Quiesce the app so it isn't querying mid-swap.
  await perfAsync('restore.scaleDownApp', async () => scaleDownApp(serverIp, sshKeyPath));
  try {
    // 3. Bounce the db StatefulSet → walg-restore init container clears PGDATA
    //    and runs `wal-g backup-fetch` before postgres starts.
    s.message('Fetching from S3 + recovering (wal-g)');
    await perfAsync('restore.walgFetch', async () => {
      await sshKubectl(serverIp, sshKeyPath, [
        'rollout',
        'restart',
        `statefulset/${DB_STATEFULSET}`,
        '-n',
        'vibecarbon',
      ]);
      // 120s server-side inside a 130s client cap: the declared 600s never
      // functioned — sshRun's 120s client default cut this wait to 2 minutes
      // on every run (all green matrix restores completed within it).
      await sshKubectl(
        serverIp,
        sshKeyPath,
        [
          'rollout',
          'status',
          `statefulset/${DB_STATEFULSET}`,
          '-n',
          'vibecarbon',
          '--timeout=120s',
        ],
        { timeout: 130_000 },
      );
    });
    // 4. Confirm postgres accepts connections post-recovery.
    await perfAsync('restore.verifyPostgres', async () => verifyPostgres(serverIp, sshKeyPath));
  } finally {
    // 5. Always clear the marker so an unrelated future pod restart does NOT
    //    re-fetch and wipe live data. Runs even if the restore failed.
    await setRestoreMarker(serverIp, sshKeyPath, '');
  }
  // 6. Bring the app back.
  await perfAsync('restore.scaleUpApp', async () => scaleUpApp(serverIp, sshKeyPath));
  s.stop('Database restored');

  p.log.success('Restore completed successfully');
  p.log.info('The application has been scaled back up.');

  // k8s-HA: the standby is a SEPARATE cluster deployed with `restore: null` — a
  // streaming replica, never wal-g-restored (a wal-g fetch on the standby would
  // create a divergent timeline; see k8s/ha/index.js). This restore rewound the
  // PRIMARY to an earlier LSN, so the standby now has WAL AHEAD of the primary
  // and CANNOT resume streaming (timeline divergence).
  //
  // Finding #2: instead of the old warn-and-point-to-`deploy`, perform a
  // first-class VERIFIED re-seed of the standby using the SHARED reseed
  // primitive (the same hardened staged-basebackup+atomic-swap the failover path
  // uses), then confirm streaming from the restored primary. Fail loudly if it
  // can't complete — never silently leave a diverged standby.
  const isK8sHA = !!(envConfig.ha?.enabled || envConfig.ha === true || envConfig.secondaryRegion);
  if (isK8sHA) {
    const servers = identifyServers(envName, envConfig, {});
    const standbyIp = servers?.standby?.ip;
    // The standby SUPABASE node hosts the db pod's local-path PVC — the re-seed's
    // node-side PGDATA swap ssh's there. No masterIp fallback: swapping on the
    // wrong node would be destructive-in-the-wrong-place, so fail loudly instead.
    const standbySupabaseIp = servers?.standby?.supabaseIp;
    if (!standbyIp || !standbySupabaseIp) {
      // We can't locate the standby — fail loudly rather than report a clean
      // restore while the standby silently diverges.
      throw new Error(
        'HA restore: the primary was restored, but the standby cluster or its ' +
          'supabase node could not be resolved from config, ' +
          'so the standby could NOT be ' +
          `re-seeded and now has a DIVERGED timeline. DR is not guaranteed. Resync with ` +
          `\`vibecarbon deploy ${envName}\` (re-runs the verified replication setup).`,
      );
    }

    // The wal-g restore wiped pg_replslot on the primary (slots are never part
    // of a base backup). The reseeded standby STREAMS through this persistent
    // slot post-swap (primary_slot_name) — without it, it connects and errors
    // `replication slot "…" does not exist`, so it never streams. (The basebackup
    // itself uses a temp slot now and no longer needs this — streaming does.)
    // Recreate it idempotently first — same IF-NOT-EXISTS block primary-init.sql uses.
    s.start('Recreating replication slot on restored primary');
    try {
      await ensureReplicationSlot(serverIp, sshKeyPath);
    } catch (err) {
      s.stop('Replication slot recreation failed');
      throw new Error(
        `HA restore: the primary was restored, but recreating the replication slot ` +
          `FAILED: ${err.message}\nWithout the slot the standby cannot be re-seeded and ` +
          `has a DIVERGED timeline, DR is not guaranteed. Resync with ` +
          `\`vibecarbon deploy ${envName}\`.`,
      );
    }
    s.stop('Replication slot present on restored primary');

    s.start('Re-seeding standby cluster from restored primary (pg_basebackup)');
    let reseedResult;
    try {
      reseedResult = await reseedStandbyFromPrimary(standbyIp, sshKeyPath, {
        standbySupabaseIp,
        // The re-seed dials the standby's LOCAL WireGuard relay (private IP :
        // gateway port) — the deploy-time transport, unchanged by a restore.
        standbySupabasePrivateIp: servers?.standby?.supabasePrivateIp,
      });
    } catch (err) {
      s.stop('Standby re-seed failed');
      throw new Error(
        `HA restore: the primary was restored and is serving, but re-seeding the standby ` +
          `FAILED: ${err.message}\nThe standby has a DIVERGED timeline and is NOT replicating, ` +
          `DR is not guaranteed. Resync with \`vibecarbon deploy ${envName}\`.`,
      );
    }
    if (reseedResult === 'skipped') {
      s.stop('Standby re-seed skipped, primary unreachable from standby');
      throw new Error(
        'HA restore: the standby could NOT reach the restored primary to re-seed ' +
          '(cross-cluster connectivity). The standby has a DIVERGED timeline and is NOT ' +
          `replicating, DR is not guaranteed. Verify the replication firewall/network, then ` +
          `resync with \`vibecarbon deploy ${envName}\`.`,
      );
    }
    s.stop('Standby re-seeded from restored primary');

    // Confirm streaming from the restored primary — a re-seed that boots but
    // never streams is still a diverged standby.
    s.start('Verifying standby is streaming from restored primary');
    const { streaming, lastState } = await verifyStreaming({
      readState: async () => readReplicationState(servers.primary.ip, sshKeyPath),
      attempts: 15,
      delaysMs: [1000, 2000, 3000],
      sleep: verifySleep,
    });
    if (!streaming) {
      s.stop('Standby streaming NOT confirmed');
      throw new Error(
        `HA restore: the standby was re-seeded but streaming replication is NOT confirmed ` +
          `(last pg_stat_replication.state=${
            lastState ? JSON.stringify(lastState) : 'no replica connected'
          }). DR is not guaranteed. Resync with \`vibecarbon deploy ${envName}\`.`,
      );
    }
    s.stop('Standby streaming from restored primary: DR restored');
  }

  p.log.info(`Verify with: ${c.info(`vibecarbon status ${envName}`)}`);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export { SPEC };
