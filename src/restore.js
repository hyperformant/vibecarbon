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
import * as p from '@clack/prompts';
import { identifyServers } from './failover.js';
import { formatInstant } from './lib/backup-format.js';
import { resolveEnvContext } from './lib/cli/env-context.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { loadProjectConfig, saveProjectConfig } from './lib/config.js';
// Static imports (no cycle: neither compose/index.js nor compose/ha.js imports
// restore.js). Aliased so runComposeRestore can default to the real functions
// while still accepting injected mocks for unit tests.
import {
  composePsqlRunner,
  configureStandbyReplication as realConfigureStandbyReplication,
} from './lib/deploy/compose/ha.js';
import {
  composeHaStackOf,
  composeHaStandbyResyncHint,
  detectComposeHaRoleSwap,
} from './lib/deploy/compose/ha-role-swap.js';
import { restoreCompose as realRestoreCompose } from './lib/deploy/compose/index.js';
import { DB_CONTAINER, DB_POD, DB_STATEFULSET } from './lib/deploy/db-workload.js';
import {
  assertNoFailoverInFlight,
  readReplicaState,
  markStandbyUnproven as realMarkStandbyUnproven,
  recordSystemIdentifier as realRecordSystemIdentifier,
  swappedSinceLastDeploy,
} from './lib/deploy/failover-guard.js';
import {
  k8sPsqlRunner,
  ensureReplicationSlot as realEnsureReplicationSlot,
  readK8sReplicationState as realReadK8sReplicationState,
  reseedStandbyFromPrimary as realReseedStandbyFromPrimary,
  restoreRolloutTimeoutS,
  verifyStreaming,
} from './lib/deploy/replication.js';
import { wgIpOf } from './lib/deploy/wireguard.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { perfAsync } from './lib/perf.js';
import { confirmProdOrExit } from './lib/prod-confirm.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import { getPostgresPod, getSSHKeyPath, sshKubectl } from './lib/ssh.js';
import { createTracker } from './lib/tracker.js';
import { RESTORE_PITR_RE } from './lib/walg/recovery-config.js';
import {
  AmbiguousLineageError,
  assertLineageCoversPoint,
  backupCredentialVars,
  createS3Client,
  NoRestorePointError,
  parseRestoreSource,
  pickRestoreBase,
  printBaseBackupList,
  readEnvBaseBackups,
  resolveS3Config,
  restoredLineageRecord,
  restoreLineageCommands,
  restorePointOf,
} from './lib/walg/restore-base.js';
import {
  assertRestoreFits,
  LINEAGE_RE,
  PREVIOUS_PGDATA_PATH,
  PROVEN_WRITABLE_STATES,
  REMOVE_DISCARD_SH,
  RETIRE_PREVIOUS_SH,
  restoreMarkerStringData,
} from './lib/walg/restore-layout.js';
import {
  assertRestoredPrimaryWritable,
  clearRestoreMarker,
  setRestoreMarker,
} from './lib/walg/restore-marker.js';

// Moved to src/lib/walg/restore-marker.js (shared with deploy -restore);
// re-exported for the callers and tests that import it from here.
export { assertRestoredPrimaryWritable };

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'restore',
  summary: 'Restore the database from a backup',
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
      value: '<latest|base-name|ISO-timestamp>',
      description:
        'Restore point: `latest` (newest base backup + all WAL), a base backup name (that base + all WAL), or an ISO-8601 timestamp (PITR)',
    },
    {
      name: 'lineage',
      value: '<system-identifier>',
      description:
        "The database lineage to restore from. Each database archives in its own folder, so a destroyed and redeployed environment leaves its old backups beside the new database's. Needed only when more than one lineage holds backups; the refusal names them.",
    },
    {
      name: 'confirm',
      value: '<value>',
      description:
        'Production only: supply the type-to-confirm value on the command line (scripts / no TTY)',
    },
  ],
  examples: [
    { command: 'vibecarbon restore', description: 'prompts for env and restore point' },
    { command: 'vibecarbon restore prod -l', description: 'list available backups for prod' },
    {
      command: 'vibecarbon restore prod -y -source latest -confirm prod',
      description: 'restore the most-recent backup, non-interactively (prod needs -confirm)',
    },
    {
      command: 'vibecarbon restore prod -source 2026-06-22T14:30:00Z',
      description: 'point-in-time recovery to a specific moment (wal-g WAL replay)',
    },
    {
      command: 'vibecarbon restore prod -lineage 7699032860122738725 -source latest',
      description: "restore the backups a destroyed environment's database left",
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

// RESTORE_PITR_RE (src/lib/walg/recovery-config.js) is the one ISO-8601
// target format: buildRecoveryConfig rejects any other.

/**
 * Resolve `-source` into a wal-g restore POINT.
 *
 * Restore is wal-g-native for compose and k8s: it fetches the base backup the
 * CLI resolved from the bucket (the newest, or the newest that finished at or
 * before a PITR instant) and replays WAL either to the present (`latest`) or
 * to an ISO-8601 instant (PITR). There is no "restore this file": the legacy
 * `backups/*_full.tar.gz` objects are not wal-g backups and local dumps
 * cannot be loaded (runComposeRestore / runK8sRestore reject `kind: local`).
 * Until 2026-09-15 this special-cased `latest` and sent everything else
 * through the tar.gz filename validator — so the advertised PITR form exited
 * with "Backup filename must match <safe-name>.(tar|sql)[.gz]", and a local
 * path got as far as the SSH step before failing. Reject the unsupported
 * shapes here, naming the two that work.
 *
 * A wal-g base backup name (`base_<24 hex>`, or a delta `…_D_<24 hex>`), as
 * `vibecarbon backup` prints it, restores THAT base and replays all WAL:
 * `{ kind: 's3', name: 'latest', base }`.
 *
 * @param {string} source
 * @returns {{ kind: 's3', name: string, base?: string }}
 */

export function resolveRestoreTarget(source) {
  const parsed = parseRestoreSource(source);
  if (parsed) return parsed;
  const why = existsSync(source)
    ? 'Local backup files cannot be restored'
    : /\.(tar|sql)(\.gz)?$/.test(source)
      ? 'Backup files cannot be restored by name'
      : `"${source}" is not a restore point`;
  p.log.error(
    `${why}: restore is wal-g-based and pulls from S3. ` +
      'Pass `-source latest` for the most recent base backup plus all WAL, a base backup ' +
      'name (e.g. base_000000010000000000000004) for that base plus all WAL, or an ISO-8601 ' +
      'timestamp (e.g. 2026-06-22T14:30:00Z) for point-in-time recovery.',
  );
  process.exit(1);
}

// pickRestoreBase moved to src/lib/walg/restore-base.js (shared with
// deploy -restore); re-exported for the callers and tests that import it here.
export { pickRestoreBase };

// ============================================================================
// MAIN
// ============================================================================

/**
 * @param {string[]} args
 * @param {object} [deps]  Test seams; production passes none.
 * @param {typeof resolveS3Config} [deps.resolveS3Config]
 * @param {(cfg: object) => any} [deps.createS3Client]
 */
export async function run(args, deps = {}) {
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
    actionVerb: 'restore',
    envRequirement: 'name an environment to restore',
    values,
    positional,
    projectConfig,
    serverIp: 'primary',
  });

  // A failover in flight (its journal set) may be promoting the standby while
  // the old primary is fenced: a restore would rewind and restart the fenced
  // old primary next to it (two writable primaries) and, on k8s, reseed the
  // standby that may be the promoted one. Refuse before any prompt or SSH.
  if (!values.l) {
    try {
      assertNoFailoverInFlight({ environment: envName, envConfig, action: 'restore' });
    } catch (err) {
      p.log.error(err.message);
      process.exit(1);
    }
  }

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

  const projectName = projectConfig.projectName || 'project';
  const isCompose = envConfig.deployMode === 'compose' || envConfig.deployMode === 'compose-ha';

  // The base backups come from the stop sentinels in the backup bucket, read
  // here in the CLI (H3), so restore needs the bucket's credentials locally:
  // the provider's object-storage env vars, or the prompt (never with -y or
  // off a TTY). Resolved before anything on the server is touched, and before
  // the firewall refresh and SSH, which `-l` does not need at all.
  //
  // One lineage's backups (Decision 2): -lineage, or the one on record when it
  // covers the restore point and no other is newer. Ambiguous refuses here,
  // naming each lineage and the flag, before anything is touched.
  const sourceForLineage = values.source ? parseRestoreSource(String(values.source)) : null;
  const lineageTarget =
    sourceForLineage && sourceForLineage.name !== 'latest'
      ? new Date(sourceForLineage.name)
      : 'latest';
  let listing;
  try {
    listing = await readEnvBaseBackups({
      envName,
      envConfig,
      projectName,
      skipPrompts: !!values.y || !process.stdin.isTTY,
      lineage: values.lineage ?? null,
      target: lineageTarget,
      resolveS3: deps.resolveS3Config ?? resolveS3Config,
      makeClient: deps.createS3Client ?? createS3Client,
    });
  } catch (err) {
    // -l lists: more than one lineage is an answer, not an error.
    if (values.l && err instanceof AmbiguousLineageError) {
      p.log.info(err.message);
      p.outro('');
      return;
    }
    if (err instanceof AmbiguousLineageError || err instanceof NoRestorePointError) {
      p.log.error(`Cannot restore ${envName}: ${err.message}`);
      if (err instanceof AmbiguousLineageError) {
        const source = values.source ? ` -source ${values.source}` : '';
        p.log.info(
          restoreLineageCommands({ envName, lineages: err.lineages, suffix: source }).join('\n'),
        );
      }
      process.exit(1);
    }
    p.log.error(
      `Could not read the base backups from the backup bucket: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (!listing.s3Config) {
    p.log.error(
      `Restore reads the base backups from ${envName}'s backup bucket and needs its credentials: ` +
        `export ${backupCredentialVars(envConfig)}${values.y ? '' : ', or enter them when asked'}, then rerun.`,
    );
    process.exit(1);
  }
  const { backups, location } = listing;

  // -l: list-only path. Read-only, bucket only; print and exit.
  if (values.l) {
    printBaseBackupList({ backups, envName, location });
    p.outro('');
    return;
  }
  if (backups.length === 0) {
    p.log.error(`No base backups found in ${location}: there is nothing to restore.`);
    p.log.info(`Create one with: ${c.info(`vibecarbon backup ${envName}`)}`);
    process.exit(1);
  }

  // Operator-IP firewall refresh: everything below needs SSH/k8s reachability.
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

  // Resolve the restore point. `-source latest` (e2e, post-incident scripts)
  // and `-y` both mean the newest base backup plus all WAL; `-source
  // <ISO-8601>` is a point-in-time target. A bare interactive run opens the
  // restore-point chooser.
  const wantsLatest = values.source === 'latest';
  let chosenSource;
  if (!wantsLatest && values.source) {
    chosenSource = resolveRestoreTarget(/** @type {string} */ (values.source));
  } else if (wantsLatest) {
    chosenSource = { kind: 's3', name: 'latest' };
  } else {
    chosenSource = await pickInteractiveSource({ backups, yes: !!values.y });
  }

  if (!chosenSource) {
    p.log.error('No backup selected.');
    process.exit(1);
  }

  // The exact base backup this restore fetches, before any confirmation or
  // stop: a point-in-time target older than every base refuses here.
  // A point picked in the chooser after the lineage was resolved for latest
  // must lie in that lineage (M5): say which lineage would cover it.
  let base;
  try {
    assertLineageCoversPoint({
      envName,
      lineage: listing.lineage,
      backups,
      lineages: listing.lineages,
      point: chosenSource.base ? 'latest' : chosenSource.name,
    });
    base = pickRestoreBase(backups, chosenSource);
  } catch (err) {
    if (!(err instanceof NoRestorePointError)) throw err;
    p.log.error(
      `Cannot restore ${chosenSource.base ?? chosenSource.name}: ${err.message} (in ${location}).`,
    );
    process.exit(1);
  }

  // Confirmation gates
  p.log.warn('This will overwrite the current database!');
  p.log.message(`  ${c.dim('Environment'.padEnd(14))} ${c.bold(envName)}`);
  p.log.message(`  ${c.dim('Server'.padEnd(14))} ${c.bold(serverIp)}`);
  p.log.message(`  ${c.dim('Backup'.padEnd(14))} ${c.bold(base.name)}`);
  p.log.message(`  ${c.dim('Finished'.padEnd(14))} ${c.bold(formatInstant(base.finishTime))}`);
  p.log.message(
    `  ${c.dim('Restore to'.padEnd(14))} ${c.bold(chosenSource.name === 'latest' ? 'latest (all WAL)' : chosenSource.name)}`,
  );

  if (!values.y) {
    const confirm = await p.confirm({
      message: `Restore ${c.bold(base.name)} to ${c.bold(envName)}?`,
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
  await confirmProdOrExit(envName, {
    actionLabel: 'restore',
    yes: !!values.y,
    confirm: values.confirm ?? undefined,
  });

  // Dispatch by mode
  const tracker = createTracker('restore', { environment: envName });
  const s = tracker.spinner();

  try {
    if (isCompose) {
      await runComposeRestore({
        s,
        chosenSource,
        base,
        lineage: listing.lineage,
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
        base,
        lineage: listing.lineage,
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

  // The database now serving is the restored lineage's: record it, so the
  // next restore reads its folder (a restore from an earlier lineage moves the
  // one before it to priorLineages).
  recordRestoredLineage(envName, listing.lineage);

  tracker.finish();
  p.outro(c.success('Done'));
}

/**
 * Persist the restored lineage as `backup.lineage`. A save that fails warns:
 * the next deploy records it from the database itself.
 */
function recordRestoredLineage(envName, lineage) {
  try {
    const config = loadProjectConfig();
    const envConfig = config?.environments?.[envName];
    if (!envConfig) return;
    // Also clears backup.unrestoredPrior: the operator chose this lineage.
    const { unrestoredPrior: _cleared, ...kept } = envConfig.backup ?? {};
    envConfig.backup = { ...kept, ...restoredLineageRecord(envConfig.backup, lineage) };
    saveProjectConfig(config);
  } catch (err) {
    p.log.warn(
      `could not record backup lineage ${lineage} in .vibecarbon.json ` +
        `(${String(err?.message ?? err).split('\n')[0]}); the next vibecarbon deploy records it`,
    );
  }
}

// ============================================================================
// ORCHESTRATION HELPERS
// ============================================================================

async function pickInteractiveSource({ backups, yes }) {
  // A restore-POINT chooser, not a backup picker: the CLI resolves the base
  // backup from the point (the newest base for "latest", the newest that
  // finished at or before a point-in-time target).
  if (yes) {
    return { kind: 's3', name: 'latest' };
  }

  // The window a point in time can fall in starts at the oldest base's finish.
  const sorted = [...backups].sort((a, b) => a.finishTime.getTime() - b.finishTime.getTime());
  const oldest = formatInstant(sorted[0].finishTime);
  const newest = formatInstant(sorted[sorted.length - 1].finishTime);
  p.log.info(
    sorted.length === 1
      ? `1 base backup, finished ${newest}: a point in time can be any instant after it`
      : `${sorted.length} base backups, the oldest finished ${oldest} and the newest ${newest}: ` +
          `a point in time can be any instant after ${oldest}`,
  );

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

  // Point-in-time: WAL replays from the resolved base up to this instant.
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

/**
 * The base a runner restores must be resolved by the caller (run, from the
 * bucket's stop sentinels): the runners never pick one, and never fall back
 * to LATEST.
 */
function assertResolvedBase(base, lineage) {
  if (!base?.name) {
    throw new Error(
      'restore needs a resolved base backup (listBaseBackups + resolveRestoreBase) before it touches the server',
    );
  }
  if (!LINEAGE_RE.test(String(lineage ?? ''))) {
    throw new Error(
      'restore needs the lineage the base backup came from (resolveRestoreLineage) before it touches the server',
    );
  }
}

// compose restore is wal-g-based (S3 pull, no file transfer). Mirrors
// runK8sRestore's structure: reject local-file sources and a missing base,
// call restoreCompose with the resolved base (it stages, swaps, waits for
// promotion and proves the result writable before the previous cluster goes).
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
  base,
  lineage,
  envName,
  projectName,
  serverIp,
  sshKeyPath,
  envConfig = {},
  restoreCompose = realRestoreCompose,
  configureStandbyReplication = realConfigureStandbyReplication,
  markStandbyUnproven = realMarkStandbyUnproven,
  recordSystemIdentifier = realRecordSystemIdentifier,
  readStandbyState = (ip) =>
    readReplicaState({ exec: composePsqlRunner(ip, sshKeyPath, `/opt/${projectName}`) }),
  assertWritable = () =>
    assertRestoredPrimaryWritable({
      environment: envName,
      envConfig,
      exec: composePsqlRunner(serverIp, sshKeyPath, `/opt/${projectName}`),
    }),
}) {
  assertResolvedBase(base, lineage);
  // Also here, for every caller: see run().
  assertNoFailoverInFlight({ environment: envName, envConfig, action: 'restore' });
  if (chosenSource.kind === 'local') {
    throw new Error(
      'compose restore is wal-g-based and pulls from S3, local backup files are not supported. ' +
        'Use `-source latest` or an ISO-8601 timestamp for PITR.',
    );
  }

  const { target, recoveryConf } = restorePointOf(chosenSource, lineage);

  s.start(`Restoring ${base.name} via wal-g (app will be temporarily unavailable)`);
  // restoreCompose proves the restored database writable (assertWritable)
  // before it removes the previous cluster and brings the app back.
  await restoreCompose(serverIp, sshKeyPath, projectName, {
    backup: base.name,
    lineage,
    target,
    recoveryConf,
    requiredBytes: base.uncompressedBytes ?? base.sizeBytes,
    assertWritable,
  });
  s.stop('Database restored');

  // compose-ha: the wal-g restore rewound the primary to an earlier LSN, so the
  // standby now has WAL AHEAD of the primary and cannot resume streaming. Re-seed
  // it with a fresh pg_basebackup from the restored primary so it rejoins the new
  // timeline. (configureStandbyReplication is destructive-by-design: it wipes the
  // standby's PGDATA and re-basebackups — exactly what we want here.)
  //
  // A re-seed failure is NOT a restore failure: the primary is restored and
  // serving — only the standby is degraded. Warn (don't rethrow) so the restore
  // still reports success, with `deploy` as the resync (composeHaStandbyResyncHint).
  //
  // C2: on a failed-over env (roles swapped against the stacks, or a failover
  // after the last deploy) the standby is rebuilt by role, and that is the
  // deploy's reconverge (compose/ha-role-swap.js): restore never re-seeds there,
  // it says why and names `vibecarbon deploy`. A failover still in flight never
  // gets here: the restore refuses up front.
  if (envConfig.deployMode === 'compose-ha') {
    const primary = envConfig.servers?.find((sv) => sv.role === 'primary');
    const standby = envConfig.servers?.find((sv) => sv.role === 'standby');
    if (
      detectComposeHaRoleSwap({ projectName, environment: envName, envConfig }) ||
      swappedSinceLastDeploy(envConfig)
    ) {
      markStandbyUnproven({ environment: envName });
      p.log.warn(
        'Primary restored and serving. Skipping the standby re-seed here: this pair has ' +
          'failed over at some point, so its standby is rebuilt by `vibecarbon deploy`, which ' +
          'resolves the nodes by role. ' +
          composeHaStandbyResyncHint({ projectName, environment: envName, envConfig }),
      );
    } else if (standby?.ip) {
      try {
        s.start('Re-seeding standby from restored primary (pg_basebackup)');
        await configureStandbyReplication(standby.ip, serverIp, sshKeyPath, projectName, {
          primaryHost: wgIpOf({
            stackIdentity: composeHaStackOf(primary, projectName, envName) ?? 'primary',
          }),
        });
        // Re-seeded is proven only by a reading in recovery with an identifier:
        // that is what the next failover's replica proof compares against.
        const seeded = await readStandbyState(standby.ip);
        if (seeded.inRecovery !== true || !seeded.systemIdentifier) {
          throw new Error('the re-seeded standby did not read back as a replica');
        }
        recordSystemIdentifier({ environment: envName }, seeded.systemIdentifier);
        s.stop('Standby re-seeded from restored primary');
      } catch (err) {
        s.stop('Standby re-seed failed');
        markStandbyUnproven({ environment: envName });
        p.log.warn(
          `Primary restored and serving, but standby re-seed failed: ${err.message}. ` +
            composeHaStandbyResyncHint({ projectName, environment: envName, envConfig }),
        );
      }
    } else {
      markStandbyUnproven({ environment: envName });
      p.log.warn(
        'compose-ha restore: no standby server found to re-seed, skipping (verify replication manually).',
      );
    }
  }

  p.log.success('Restore completed successfully');
  p.log.info(`Verify with: ${c.info(`vibecarbon status ${envName}`)}`);
}

// k8s restore is wal-g-native: postgres + wal-g live in the db pod, which
// archives WAL + base backups to S3. Restore = set the restore marker on
// vibecarbon-infra-secrets (RESTORE_BACKUP, the base resolved here, plus the
// rendered recovery config) → bounce the db StatefulSet so its walg-restore
// init container fetches that backup into a staging dir and swaps it in →
// wait for promotion and prove the result writable → clear the marker and
// remove the previous cluster. No bytes flow through the operator; wal-g
// pulls from S3 inside the cluster. The workload name is DB_STATEFULSET
// (src/lib/deploy/db-workload.js).

/** Free bytes on the db pod's PGDATA volume, or null when unreadable. */
async function k8sPgdataFreeBytes(ip, sshKeyPath) {
  try {
    const out = await sshKubectl(ip, sshKeyPath, [
      'exec',
      '-n',
      'vibecarbon',
      DB_POD,
      '-c',
      DB_CONTAINER,
      '--',
      'df',
      '-Pk',
      '/var/lib/postgresql/data',
    ]);
    const row =
      String(out ?? '')
        .trim()
        .split('\n')[1] ?? '';
    const kb = Number.parseInt(row.trim().split(/\s+/)[3] ?? '', 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** Poll until the db pod's postgres has left recovery (promoted). */
async function waitForK8sPromotion(
  ip,
  sshKeyPath,
  { timeoutMs = 300_000, intervalMs = 2_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const out = await sshKubectl(ip, sshKeyPath, [
        'exec',
        '-n',
        'vibecarbon',
        DB_POD,
        '-c',
        DB_CONTAINER,
        '--',
        'psql',
        '-U',
        'postgres',
        '-At',
        '-c',
        'SELECT pg_is_in_recovery()',
      ]);
      if (String(out ?? '').trim() === 'f') return;
      last = 'pg_is_in_recovery() still true';
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the restored database did not promote within ${Math.round(timeoutMs / 1000)}s (${last}). ` +
          `The restore marker stays set and the database from before the restore is kept in ${PREVIOUS_PGDATA_PATH}.`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function runK8sRestore({
  s,
  chosenSource,
  base,
  lineage,
  envName,
  serverIp,
  sshKeyPath,
  envConfig = {},
  // Injected so the k8s-HA standby re-seed dispatch is unit-testable without a
  // real cluster (mirrors runComposeRestore). Production passes none.
  reseedStandbyFromPrimary = realReseedStandbyFromPrimary,
  ensureReplicationSlot = realEnsureReplicationSlot,
  readReplicationState = realReadK8sReplicationState,
  markStandbyUnproven = realMarkStandbyUnproven,
  recordSystemIdentifier = realRecordSystemIdentifier,
  assertWritable = () =>
    assertRestoredPrimaryWritable({
      environment: envName,
      envConfig,
      exec: k8sPsqlRunner(serverIp, sshKeyPath),
    }),
  readFreeBytes = () => k8sPgdataFreeBytes(serverIp, sshKeyPath),
  // Pacing for the post-reseed streaming verify — injectable so tests don't wait
  // on real timers. Production uses the default setTimeout-backed sleep.
  verifySleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  assertResolvedBase(base, lineage);
  // Also here, for every caller: see run().
  assertNoFailoverInFlight({ environment: envName, envConfig, action: 'restore' });
  if (chosenSource.kind === 'local') {
    throw new Error(
      'k8s restore is wal-g-based and pulls from S3 — local backup files are not supported. Use `-source latest` (or a timestamp for PITR).',
    );
  }
  const { target, recoveryConf } = restorePointOf(chosenSource, lineage);

  // 0. The staged fetch needs the backup's size free next to the live cluster.
  //    Refuse before anything stops.
  assertRestoreFits({
    requiredBytes: base.uncompressedBytes ?? base.sizeBytes ?? 0,
    freeBytes: await readFreeBytes(),
    where: `${DB_POD}'s data volume`,
    warn: (msg) => p.log.warn(msg),
  });

  const rolloutTimeoutS = restoreRolloutTimeoutS(base.sizeBytes);
  s.start(`Restoring ${base.name} via wal-g (app will be temporarily unavailable)`);
  // 1. Mark the restore so the db pod's init container fetches this backup on
  //    its next boot.
  await setRestoreMarker({
    ip: serverIp,
    sshKeyPath,
    backup: base.name,
    target,
    recoveryConf,
    lineage,
  });
  // 2. Quiesce the app so it isn't querying mid-swap.
  await perfAsync('restore.scaleDownApp', async () => scaleDownApp(serverIp, sshKeyPath));
  // 3. Bounce the db StatefulSet → walg-restore stages the fetch and swaps it
  //    in before postgres starts. The wait scales with the backup (M1): a
  //    fixed boot timeout cut large fetches short.
  s.message(`Fetching ${base.name} from S3 + recovering (wal-g)`);
  try {
    await perfAsync('restore.walgFetch', async () => {
      await sshKubectl(serverIp, sshKeyPath, [
        'rollout',
        'restart',
        `statefulset/${DB_STATEFULSET}`,
        '-n',
        'vibecarbon',
      ]);
      await sshKubectl(
        serverIp,
        sshKeyPath,
        [
          'rollout',
          'status',
          `statefulset/${DB_STATEFULSET}`,
          '-n',
          'vibecarbon',
          `--timeout=${rolloutTimeoutS}s`,
        ],
        { timeout: (rolloutTimeoutS + 30) * 1000 },
      );
    });
  } catch (err) {
    // The marker stays set: clearing it here made the next pod start boot
    // whatever a failed fetch left (the old `finally`). The init keeps the
    // live cluster until a fetch completes, so a retry is safe.
    throw new Error(
      `the db pod did not come back from the restore of ${base.name} within ${rolloutTimeoutS}s: ` +
        `${err instanceof Error ? err.message : String(err)}. The restore marker stays set, so the pod ` +
        `retries the restore on its next start. See why with: kubectl logs ${DB_POD} -c walg-restore -n vibecarbon, ` +
        'then rerun vibecarbon restore.',
    );
  }
  // 4. Confirm postgres accepts connections and has left recovery.
  await perfAsync('restore.verifyPostgres', async () => verifyPostgres(serverIp, sshKeyPath));
  await perfAsync('restore.waitPromoted', async () => waitForK8sPromotion(serverIp, sshKeyPath));
  // 4b. Rebuild planner statistics before the app comes back. A base backup
  //     carries none: until autovacuum runs, n_live_tup reads 0 for every
  //     table and the first queries plan blind — which looks exactly like
  //     data loss to whoever verifies the restore (vibecarbon-web
  //     2026-09-15; same step in restoreCompose). Best-effort: the restore
  //     itself has already succeeded.
  await perfAsync('restore.analyze', async () => {
    try {
      const pod = await getPostgresPod(serverIp, sshKeyPath);
      await sshKubectl(
        serverIp,
        sshKeyPath,
        ['exec', '-n', 'vibecarbon', pod, '--', 'psql', '-U', 'postgres', '-q', '-c', 'ANALYZE'],
        { timeout: 300_000 },
      );
    } catch (err) {
      p.log.warn(
        `ANALYZE after restore failed (${err instanceof Error ? err.message : String(err)}); ` +
          'planner statistics will rebuild on the next autovacuum.',
      );
    }
  });
  // 5. Before the marker goes and the app comes back: the restored database
  //    must take writes. An unreadable fence is not a proof (I4): the marker
  //    and the previous cluster stay, the app stays down.
  const proof = await assertWritable();
  if (!PROVEN_WRITABLE_STATES.includes(proof)) {
    const inDb = `kubectl -n vibecarbon exec ${DB_POD} -c ${DB_CONTAINER} --`;
    throw new Error(
      [
        `could not prove the restored database writable (write fence ${proof ?? 'unread'}), so the restore`,
        `marker stays set and the database from before the restore is kept in ${PREVIOUS_PGDATA_PATH}.`,
        `Check it on ${serverIp} (expect off):`,
        `  ${inDb} psql -U postgres -At -c 'SHOW default_transaction_read_only'`,
        `Then finish on ${serverIp}, one command at a time:`,
        `  ${inDb} sh -c '${RETIRE_PREVIOUS_SH}'`,
        `  kubectl -n vibecarbon patch secret vibecarbon-infra-secrets --type=merge -p '${JSON.stringify({ stringData: restoreMarkerStringData(null) })}'`,
        `  ${inDb} sh -c '${REMOVE_DISCARD_SH}'`,
        '  kubectl scale deployment app -n vibecarbon --replicas=2',
      ].join('\n'),
    );
  }
  // 6. Proven. Rename the previous cluster out of the .vc-prev name first (a
  //    crash after this can only leave garbage, never a .vc-prev the next
  //    restore reads as "unproven"), clear the marker (a later pod restart
  //    boots normally), then remove the discard.
  await sshKubectl(
    serverIp,
    sshKeyPath,
    ['exec', '-n', 'vibecarbon', DB_POD, '-c', DB_CONTAINER, '--', 'sh', '-c', RETIRE_PREVIOUS_SH],
    { timeout: 60_000 },
  );
  await clearRestoreMarker({ ip: serverIp, sshKeyPath });
  await sshKubectl(
    serverIp,
    sshKeyPath,
    ['exec', '-n', 'vibecarbon', DB_POD, '-c', DB_CONTAINER, '--', 'sh', '-c', REMOVE_DISCARD_SH],
    { timeout: 300_000 },
  );
  // 7. Bring the app back.
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
    // Every throw below leaves a standby that was not reseeded and verified:
    // mark it unproven first (replication degraded, identifier dropped), so the
    // replica proof cannot pass it on the identifier alone (I2).
    try {
      const servers = identifyServers(envName, envConfig, {});
      const standbyIp = servers?.standby?.ip;
      // The standby DATABASE node hosts the db pod's local-path PVC — the re-seed's
      // node-side PGDATA swap ssh's there. No masterIp fallback: swapping on the
      // wrong node would be destructive-in-the-wrong-place, so fail loudly instead.
      const standbyDbIp = servers?.standby?.dbIp;
      if (!standbyIp || !standbyDbIp) {
        // We can't locate the standby — fail loudly rather than report a clean
        // restore while the standby silently diverges.
        throw new Error(
          'HA restore: the primary was restored, but the standby cluster or its ' +
            'database node could not be resolved from config, ' +
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
          standbyDbIp,
          // The re-seed dials the standby's LOCAL WireGuard relay (private IP :
          // gateway port) — the deploy-time transport, unchanged by a restore.
          standbyDbPrivateIp: servers?.standby?.dbPrivateIp,
          // The restored primary may carry another lineage than the last seed
          // (a backup from before a re-create): record what the standby now holds.
          onSeeded: (sysid) => recordSystemIdentifier({ environment: envName }, sysid),
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
    } catch (err) {
      markStandbyUnproven({ environment: envName });
      throw err;
    }
  }

  p.log.info(`Verify with: ${c.info(`vibecarbon status ${envName}`)}`);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export { SPEC };
