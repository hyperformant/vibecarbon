/**
 * Vibecarbon Backup Command
 *
 * Interactive-by-default. Bare `vibecarbon backup` walks the operator
 * through env → action prompts; positional and flag seeds skip the
 * corresponding prompt. Off-TTY usage requires explicit flags up front
 * (the TTY guard names exactly which ones).
 *
 * Form rule: vibecarbon uses single-dash flags only — see
 * memory:feedback_cli_single_dash_flags.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { resolveEnvContext } from './lib/cli/env-context.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { selectAction } from './lib/cli/select-action.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { c } from './lib/colors.js';
import { DB_STATEFULSET } from './lib/deploy/db-workload.js';
import { awaitPostgresAccepting } from './lib/deploy/k8s/index.js';
import { ensureOperatorIpAccess } from './lib/operator-ip.js';
import { perfAsync } from './lib/perf.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerIdFor, resolveProviderToken } from './lib/providers/index.js';
import {
  getPostgresPod,
  getSSHKeyPath,
  scpDownload,
  sshKubectl,
  sshRun,
  sshRunScript,
} from './lib/ssh.js';
import { createTracker } from './lib/tracker.js';
import { validateBackupFilename } from './lib/validators.js';
import { parseBackupResult, pushedBackupNames } from './lib/walg/backup-result.js';
import {
  backupCredentialVars,
  printBaseBackupList,
  readEnvBaseBackups,
  resolveS3Config,
} from './lib/walg/restore-base.js';

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'backup',
  summary: 'Create, list, or download database backups',
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to act on (skips the env prompt)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompts' },
    {
      name: 'l',
      boolean: true,
      description: 'List backups (read-only; equivalent to -action list)',
    },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'action',
      value: '<verb>',
      enum: ['create', 'list', 'download'],
      description: 'Action seed (skips the action prompt): create, list, or download',
    },
    {
      name: 'source',
      value: '<file>',
      description:
        'Backup filename for -action download (legacy backup-pod dumps only, k8s without object storage; wal-g environments restore with `vibecarbon restore`)',
    },
  ],
  examples: [
    { command: 'vibecarbon backup', description: 'prompts for env and action' },
    { command: 'vibecarbon backup prod -l', description: 'list backups for prod' },
    { command: 'vibecarbon backup prod', description: 'env seeded; prompts for action' },
    {
      command: 'vibecarbon backup prod -action create -y',
      description: 'scripted base backup (wal-g → object storage)',
    },
  ],
};

const ACTION_CHOICES = [
  { value: 'create', label: 'Create a new backup', hint: 'triggers a fresh dump' },
  { value: 'list', label: 'List existing backups', hint: 'read-only' },
  {
    value: 'download',
    label: 'Download a backup',
    hint: 'legacy backup-pod dumps only (k8s without object storage)',
  },
];

// ============================================================================
// LEGACY POD HELPERS (used when a k8s env has no S3 configured)
// ============================================================================

async function downloadPodBackup(ip, sshKeyPath, filename) {
  const pod = await getPostgresPod(ip, sshKeyPath);

  // Copy from pod to host
  await sshKubectl(ip, sshKeyPath, [
    'cp',
    `vibecarbon/${pod}:/backups/${filename}`,
    `/tmp/${filename}`,
  ]);

  // SCP from host to local
  const localPath = join(process.cwd(), filename);
  await scpDownload(ip, sshKeyPath, `/tmp/${filename}`, localPath);

  // Clean up remote temp file
  await sshRun(ip, sshKeyPath, ['rm', '-f', `/tmp/${filename}`]);

  return localPath;
}

// ============================================================================
// K8S JOB BACKUP (triggers CronJob-based backup)
// ============================================================================

/**
 * Build the remote bash that polls a one-off backup Job to completion and, on
 * failure, captures pod diagnostics IN-LINE (before the controller GCs the
 * failed Pod). Extracted as a pure builder so the poll cadence is unit-testable.
 *
 * Poll cadence: we avoid `kubectl wait --for=condition=Complete --timeout=300s`
 * because the wait can only watch ONE condition, so on a CrashLoopBackOff that
 * ends in Failed it would burn the FULL 5 min before timing out. By that point
 * kubelet had GC'd the failed Pod (observed 2026-04-28 e2e — the Pod was visible
 * in events but kubectl get returned nothing, so the diagnostic captured no
 * logs). Polling for BOTH conditions returns promptly on Failed while the Pod is
 * still alive and its logs are still kubectl-reachable.
 *
 * The interval RAMPS 2 → 3 → 5 (not a flat 5s): wal-g push is ~11s but pod
 * scheduling + image start dominate the wall-clock, and a flat 5s poll adds up
 * to 5s of tail latency after the condition fires. The ramp keeps early
 * detection tight while a genuinely slow job still settles to 5s pacing. The
 * first condition check runs BEFORE the first sleep, so a fast job is caught
 * immediately. The 300s DEADLINE is the load-bearing ceiling and is unchanged.
 *
 * CRITICAL: capture pod logs + describe IN-LINE the moment Failed=True is
 * detected. Doing this in a follow-up SSH session race-loses to Pod GC (observed
 * iter-reliab2 2026-05-01: Job condition Failed but follow-up diagnostic
 * returned "No pod matching" because controller-manager already GC'd the failed
 * Pod within the ~1s window between SSH sessions).
 */
export function buildBackupJobWaitScript(jobName) {
  return `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
DEADLINE=$(($(date +%s) + 300))
RESULT="timeout"
INTERVAL=2
while [ $(date +%s) -lt $DEADLINE ]; do
  CONDS=$(kubectl get job ${jobName} -n vibecarbon -o jsonpath='{range .status.conditions[*]}{.type}={.status};{end}' 2>/dev/null || echo "")
  case "$CONDS" in
    *"Complete=True"*) RESULT="complete"; break ;;
    *"Failed=True"*) RESULT="failed"; break ;;
  esac
  sleep "$INTERVAL"
  case "$INTERVAL" in 2) INTERVAL=3 ;; 3) INTERVAL=5 ;; esac
done
echo "JOB_RESULT=$RESULT"
if [ "$RESULT" = "complete" ]; then
  exit 0
fi
# Capture diagnostics WHILE pod is still alive — controller GCs failed
# Job pods quickly after the Failed condition fires.
echo ""
echo "=== INLINE FAILURE DIAGNOSTICS (captured before pod GC) ==="
echo "=== Job status ==="
kubectl get job ${jobName} -n vibecarbon -o yaml 2>&1 | grep -E "^  (active|conditions|failed|ready|succeeded|terminating)|^    " | head -30
echo ""
echo "=== All pods in namespace ==="
kubectl get pods -n vibecarbon -o wide 2>&1
echo ""
echo "=== Pod events (matching ${jobName} or backup-manual) ==="
kubectl get events -n vibecarbon --field-selector involvedObject.kind=Pod --sort-by=.lastTimestamp 2>&1 | grep -E "${jobName}|backup-manual" | tail -30
echo ""
PODS=$(kubectl get pods -n vibecarbon -o name 2>/dev/null | grep "${jobName}" || true)
if [ -z "\${PODS}" ]; then
  echo "=== No pod matching ${jobName} found — already GC'd ==="
else
  for pod in \${PODS}; do
    echo "=== \${pod}: container statuses (exit code disambiguates failure) ==="
    kubectl get \${pod} -n vibecarbon -o jsonpath='restartCount={.status.containerStatuses[*].restartCount}{"\\n"}lastTerminated={.status.containerStatuses[*].lastState.terminated}{"\\n"}currentState={.status.containerStatuses[*].state}{"\\n"}' 2>&1
    echo ""
    echo "=== \${pod}: kubectl describe ==="
    kubectl describe \${pod} -n vibecarbon 2>&1 | tail -60
    echo "=== \${pod}: current container logs ==="
    kubectl logs \${pod} -n vibecarbon --tail=200 2>&1 || true
    echo "=== \${pod}: --previous logs (the crashed-container output) ==="
    kubectl logs \${pod} -n vibecarbon --previous --tail=200 2>&1 || true
  done
fi
exit 1`;
}

// The db StatefulSet the backup Job execs into (DB_STATEFULSET, imported) is
// the same workload the CronJob template (carbon/k8s/base/backup/cronjob.yaml)
// and restore.js address.

/**
 * Trigger a one-off backup Job from the CronJob template, poll it to
 * completion, and report what it did from the Job's logs (the CronJob prints
 * the same BACKUP_RESULT marker compose-backup.sh does; see
 * src/lib/walg/backup-result.js).
 *
 * Returns `{ result: 'pushed', name, job }` or `{ result: 'skipped', reason,
 * job }`; callers read `.result`. A Job that FAILED after printing a pushed
 * marker (retention failed: exit 3, which the CronJob's podFailurePolicy
 * turns into a failed Job with no second pod, so no second push) returns
 * `pushed` with `retentionError`: that base is in the bucket, and a pushed
 * base must never read as "no backup". A failed Job with no pushed marker
 * throws with the pod diagnostics.
 *
 * GATED on the condition the Job actually depends on (RCA 2026-08-16, run
 * 31927810430): the Job's first act is `kubectl exec` into the db pod, and
 * after a scale-resize reboots the nodes, Pod-Ready + API healthz hold while
 * the apiserver→kubelet exec path (k3s agent tunnels) is still converging —
 * the Job crash-looped to Failed in that window. A `pg_isready` THROUGH a
 * kubectl exec round-trip proves both halves at once: the exec transport is
 * up AND Postgres accepts connections. Reuses the deploy path's
 * awaitPostgresAccepting (mitigation-audit cluster 5) over the ssh kubectl
 * hop. Restore needs no such gate: its k8s path is apiserver-only (patch /
 * rollout, wal-g runs in an init container) and already confirms Postgres
 * post-recovery. Failover is deliberately NOT gated on the primary — its
 * precondition semantics are "primary may be dead by design".
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {object} [opts] - test seams; production callers pass none
 * @param {typeof sshKubectl} [opts.kubectlImpl]
 * @param {typeof sshRunScript} [opts.runScriptImpl]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.nowFn]
 * @returns {Promise<({result: 'pushed', name: string, retentionError?: string} | {result: 'skipped', reason: string}) & {job: string}>}
 */
export async function triggerBackupJob(ip, sshKeyPath, opts = {}) {
  const { kubectlImpl = sshKubectl, runScriptImpl = sshRunScript, sleep, nowFn } = opts;

  await awaitPostgresAccepting({
    env: process.env,
    dbPod: `statefulset/${DB_STATEFULSET}`,
    sleep,
    nowFn,
    // Route the probe over the same ssh→kubectl hop the trigger uses; argv[0]
    // is the 'kubectl' token sshKubectl prepends itself.
    exec: (argv) => kubectlImpl(ip, sshKeyPath, argv.slice(1), { silent: true }),
  });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .slice(0, 19)
    .toLowerCase();
  const jobName = `backup-manual-${timestamp}`;

  // Create a one-off Job from the CronJob template
  await kubectlImpl(ip, sshKeyPath, [
    'create',
    'job',
    `--from=cronjob/backup`,
    jobName,
    '-n',
    'vibecarbon',
  ]);

  // Poll the Job to completion (ramped-interval condition poll — see
  // buildBackupJobWaitScript for the both-conditions + inline-diagnostics
  // rationale) and capture failure diagnostics before the Pod is GC'd.
  try {
    await runScriptImpl(ip, sshKeyPath, buildBackupJobWaitScript(jobName), { timeout: 420_000 });
  } catch (waitErr) {
    // The wait script's inline diagnostics (stdout of the failed run) carry
    // the pod logs captured before GC.
    const inlineDiag = String(waitErr?.stdout ?? '');
    // Dump pod status, events, AND logs to help diagnose why the job didn't
    // complete. An earlier version of this block gated the --previous log
    // capture on a label-selector query that mysteriously returned "No
    // resources found" while the same pod was visible by name in events
    // (observed 2026-04-28 k8s e2e). Now we find pods by NAME
    // pattern instead — Job-managed pods are guaranteed to be named
    // `<jobName>-<5char>` so a `grep ${jobName}` over the unfiltered pod
    // list always works. We also capture exit codes via jsonpath (works
    // even when both current+previous logs are empty — exit code 126/127/
    // SIGKILL alone disambiguates "image bad / OOMKilled / segfault") and
    // run kubectl describe for runtime context that bare logs miss.
    let podDiag = '';
    try {
      podDiag = await runScriptImpl(
        ip,
        sshKeyPath,
        `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
echo "=== CronJob image ==="
kubectl get cronjob backup -n vibecarbon -o jsonpath="{.spec.jobTemplate.spec.template.spec.containers[0].image}" 2>&1
echo ""
echo "=== Job status ==="
kubectl get job ${jobName} -n vibecarbon -o yaml 2>&1 | grep -E "^  (active|conditions|failed|ready|succeeded|terminating)|^    " | head -30
echo "=== All pods in namespace (no label filter) ==="
kubectl get pods -n vibecarbon -o wide 2>&1
echo "=== Pod events (last 30) ==="
kubectl get events -n vibecarbon --field-selector involvedObject.kind=Pod --sort-by=.lastTimestamp 2>&1 | grep -E "${jobName}|backup-manual" | tail -30
# Find pods by NAME pattern (not label) — labels on freshly-failed Job pods
# can return empty even when the pod exists; name pattern matches because
# Job pods are deterministically named <jobName>-<5char>.
PODS=$(kubectl get pods -n vibecarbon -o name 2>/dev/null | grep "${jobName}" || true)
if [ -z "\${PODS}" ]; then
  echo "=== No pod matching ${jobName} found — already GC'd? ==="
else
  for pod in \${PODS}; do
    echo "=== \${pod}: container statuses (exit code disambiguates the failure) ==="
    kubectl get \${pod} -n vibecarbon -o jsonpath='restartCount={.status.containerStatuses[*].restartCount}{"\\n"}lastTerminated={.status.containerStatuses[*].lastState.terminated}{"\\n"}currentState={.status.containerStatuses[*].state}{"\\n"}' 2>&1
    echo ""
    echo "=== \${pod}: kubectl describe ==="
    kubectl describe \${pod} -n vibecarbon 2>&1 | tail -50
    echo "=== \${pod}: current container logs ==="
    kubectl logs \${pod} -n vibecarbon --tail=100 2>&1 || true
    echo "=== \${pod}: --previous logs (the crashed-container output) ==="
    kubectl logs \${pod} -n vibecarbon --previous --tail=100 2>&1 || true
  done
fi`,
        { timeout: 90_000 },
      );
    } catch {
      podDiag = '(diagnostic SSH failed)';
    }
    const diag = `${inlineDiag}\n${podDiag}`;
    const pushed = [...new Set(pushedBackupNames(diag))];
    if (pushed.length > 0) {
      const cause = /retention failed after pushing .*$/m.exec(diag)?.[0];
      return {
        result: 'pushed',
        name: pushed[pushed.length - 1],
        retentionError: `backup Job ${jobName} failed after it pushed ${pushed.join(', ')}: ${cause ?? waitErr.message.split('\n')[0]}`,
        job: jobName,
      };
    }
    throw new Error(
      `Backup job ${jobName} did not complete:\n${podDiag}\n\nkubectl wait error: ${waitErr.message}`,
    );
  }

  // Every pod of the Job, whole logs (a selector defaults to --tail=10). Under
  // restartPolicy Never a push that failed first leaves a failed pod beside
  // the succeeded one; only the succeeded pod printed a marker.
  // `logs job/<name>` would read ONE pod, possibly the failed one.
  const logs = await kubectlImpl(
    ip,
    sshKeyPath,
    ['logs', '-n', 'vibecarbon', '-l', `job-name=${jobName}`, '--tail=-1'],
    { silent: true },
  );
  return { ...parseBackupResult(logs), job: jobName };
}

// ============================================================================
// MAIN
// ============================================================================

export async function run(args) {
  const { values, positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Validate -source format up front — all downstream code trusts it.
  if (values.source) {
    const err = validateBackupFilename(/** @type {string} */ (values.source));
    if (err) {
      process.stderr.write(`${c.error('✗')} Invalid -source: ${err}\n`);
      process.exit(1);
    }
  }

  // Project guard runs before banner so an accidental `vibecarbon
  // backup` from a parent directory emits the canonical message.
  const projectConfig = assertInProjectDir();

  introCommand('backup');

  // -l is shorthand for -action list; if both supplied, -l wins.
  const actionSeed = values.l ? 'list' : /** @type {string|null} */ (values.action);

  // Action-specific prompts (confirm-on-create, source-on-download) get
  // their own TTY gate after the action is known, so the failure message
  // names exactly the flag the operator missed for *this* invocation.
  const { envName, envConfig, serverIp } = await resolveEnvContext({
    actionVerb: 'back up',
    envRequirement: 'name an environment to back up',
    values,
    positional,
    projectConfig,
    extraRequirements: [
      {
        flag: 'action',
        description: 'choose an action (create, list, download; or pass -l for list)',
        satisfied: !!actionSeed,
      },
    ],
    // 'primary', not 'first': a prior failover swaps the `role` field in place
    // and preserves array order, so servers[0] is the RETIRED node. Backing up
    // from it would archive a stopped, demoted database — same class as the
    // e2e role-resolution defect (see env-context.js's serverIp docs).
    serverIp: 'primary',
  });

  const action = await selectAction({
    message: `What do you want to do for ${c.bold(envName)}?`,
    choices: ACTION_CHOICES,
    seed: actionSeed,
  });

  // -l lists from the backup bucket's stop sentinels: no firewall refresh, no
  // SSH, the db need not be running.
  if (action === 'list') {
    await runList({
      envName,
      envConfig,
      projectName: projectConfig.projectName || 'project',
      yes: !!values.y,
    });
    p.outro('');
    return;
  }

  // Operator-IP whitelist refresh happens before any command that
  // touches the live cluster.
  await ensureFirewallAccessIfNeeded({
    projectConfig,
    envName,
    envConfig,
    yes: !!values.y,
  });

  // SSH key is required for create and download. Bail early with a clear
  // message if it's missing.
  const sshKeyPath = getSSHKeyPath(envName);
  if (!existsSync(sshKeyPath)) {
    p.log.error(`SSH key not found: ${sshKeyPath}`);
    p.log.info(
      'The deployment key is created during deploy and is required for backup operations.',
    );
    process.exit(1);
  }

  // Action-specific TTY checks fire after we know the action so the
  // missing-flag message is precise.
  if (action === 'create' && !values.y) {
    requireTTYOrFlags({
      requirements: [{ flag: 'y', description: 'skip the confirmation prompt', satisfied: false }],
    });
  }
  if (action === 'download' && !values.source) {
    requireTTYOrFlags({
      requirements: [
        {
          flag: 'source',
          description: 'name the backup file to download',
          satisfied: false,
        },
      ],
    });
  }

  // Resolve mode + S3 config
  const projectName = projectConfig.projectName || 'project';
  const isCompose = envConfig.deployMode === 'compose' || envConfig.deployMode === 'compose-ha';
  const s3Config = await resolveS3Config({ isCompose, envName, projectName, envConfig });
  const useS3 = Boolean(s3Config?.secretKey);

  if (!isCompose) {
    if (useS3) {
      p.log.info(`S3 storage: ${c.dim(s3Config.bucket)} (${s3Config.region})`);
    } else {
      p.log.warn('No S3 storage configured; backups cannot be persisted.');
      p.log.info(
        `Configure S3 during deployment or with: ${c.info(`vibecarbon deploy ${envName}`)}`,
      );
      p.log.info('Without S3, backup data is lost when the Job pod terminates.');
    }
  }

  const tracker = createTracker('backup', { environment: envName });
  const s = tracker.spinner();

  if (action === 'download') {
    await runDownload({
      s,
      source: /** @type {string} */ (values.source),
      isCompose,
      useS3,
      serverIp,
      sshKeyPath,
    });
    p.outro('');
    return;
  }

  // action === 'create'
  await runCreate({
    s,
    isCompose,
    s3Config,
    serverIp,
    sshKeyPath,
    projectName,
    envName,
    backupRetain: envConfig.backup?.retentionDays,
    yes: !!values.y,
  });
  tracker.finish();
  p.outro(c.success('Done'));
}

// ============================================================================
// ORCHESTRATION HELPERS
// ============================================================================

/**
 * Refresh operator-IP firewall allowlist before an action that hits the
 * cluster (create, download; list reads the bucket only).
 */
async function ensureFirewallAccessIfNeeded({ projectConfig, envName, envConfig, yes }) {
  const apiToken = resolveProviderToken(providerIdFor(envConfig));
  if (!apiToken) return;

  try {
    const isHA = envConfig.deployMode === 'compose-ha' || !!envConfig.ha?.enabled;
    const result = await ensureOperatorIpAccess({
      projectConfig,
      environment: envName,
      isHA,
      apiToken,
      yes,
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

/**
 * `-l`: the environment's base backups, read from the backup bucket's stop
 * sentinels (listBaseBackups), the same listing restore resolves from. Needs
 * the bucket's credentials locally.
 */
async function runList({ envName, envConfig, projectName, yes }) {
  let listing;
  try {
    listing = await readEnvBaseBackups({
      envName,
      envConfig,
      projectName,
      skipPrompts: yes || !process.stdin.isTTY,
    });
  } catch (err) {
    p.log.error(
      `Could not read the base backups from the backup bucket: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (!listing.s3Config) {
    p.log.error(
      `Listing backups reads ${envName}'s backup bucket and needs its credentials: ` +
        `export ${backupCredentialVars(envConfig)}, then rerun.`,
    );
    process.exit(1);
  }
  printBaseBackupList({ backups: listing.backups, envName, location: listing.location });
}

/**
 * `-action download`. Only one environment shape still has downloadable
 * backup FILES: k8s with no object storage, whose backup pod writes
 * `*_full.tar.gz` dumps. Every wal-g environment (compose always; k8s with
 * S3) archives base backups + WAL under `walg/` — there is no file to fetch,
 * `backups/<name>` never exists, and a dump could not be restored anyway
 * (restore is wal-g-native and pulls from S3). Refuse those up front rather
 * than failing on a filename-format check or a 404, and name what works.
 *
 * `deps` is a test seam (the pod helper is a module-level import).
 */
export async function runDownload({
  s,
  source,
  isCompose,
  useS3,
  serverIp,
  sshKeyPath,
  deps = {},
}) {
  const { downloadPod = downloadPodBackup } = deps;
  if (isCompose || useS3) {
    p.log.error(
      'This environment backs up with wal-g (base backups + WAL in object storage); there ' +
        'is no backup file to download, and a downloaded dump could not be restored. Use ' +
        '`vibecarbon backup <env> -l` to list restore points and `vibecarbon restore <env> ' +
        '-source latest|<ISO-8601 timestamp>` to restore one.',
    );
    process.exit(1);
  }
  s.start(`Downloading ${source}`);
  try {
    // k8s without object storage: legacy backup-pod dump.
    const localPath = await downloadPod(serverIp, sshKeyPath, source);
    s.stop('Download complete');
    p.log.success(`Saved to ${c.bold(localPath)}`);
  } catch (error) {
    s.stop('Download failed');
    p.log.error(error.message);
    process.exit(1);
  }
}

/**
 * `-action create`: push a base backup and report it. Exits 1 on a skip and on
 * a retention failure after the push (naming the base that was pushed).
 * `deps` is a test seam for the two backup runners.
 */
export async function runCreate({
  s,
  isCompose,
  s3Config,
  serverIp,
  sshKeyPath,
  projectName,
  envName,
  backupRetain,
  yes,
  deps = {},
}) {
  if (!yes) {
    const confirm = await p.confirm({
      message: `Create a database backup for ${c.bold(envName)} (${serverIp})?`,
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

  s.start(
    isCompose ? 'Creating wal-g base backup...' : 'Creating backup (triggering Kubernetes Job)',
  );
  const {
    backupCompose = async (...a) => {
      const { backupCompose: run } = await import('./lib/deploy/compose/index.js');
      return run(...a);
    },
    triggerJob = triggerBackupJob,
  } = deps;
  let backup;
  try {
    if (isCompose) {
      backup = await backupCompose(serverIp, sshKeyPath, projectName, { retain: backupRetain });
    } else {
      backup = await perfAsync('backup.triggerJob', () => triggerJob(serverIp, sshKeyPath));
    }
  } catch (error) {
    s.stop('Backup failed');
    p.log.error(error.message);
    process.exit(1);
  }

  if (backup.result !== 'pushed') {
    s.stop('Backup skipped');
    p.log.error(
      `backup skipped (${backup.reason}): nothing was pushed to ${s3Config?.bucket ?? 'the backup bucket'}.`,
    );
    process.exit(1);
  }

  // The e2e backup step keys on this line (tests/e2e/scenarios/_run-lifecycle.ts).
  s.stop(`base backup pushed: ${backup.name}`);
  if (backup.job) p.log.info(`Job: ${c.dim(backup.job)}`);
  if (backup.retentionError) {
    p.log.error(
      `Base backup ${backup.name} was pushed and is restorable, but pruning old backups failed: ${backup.retentionError}`,
    );
    process.exit(1);
  }
  p.log.info(`List backups: ${c.info(`vibecarbon backup ${envName} -l`)}`);
}

// SPEC is exported for the arg-parser unit tests.
export { SPEC };
