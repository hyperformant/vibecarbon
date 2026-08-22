/**
 * Moving the wal-g WRITE-GUARD during failover.
 *
 * `WALG_ROLE` is rendered once, at deploy time, from the deploy's notion of
 * which node is which. Failover moves the role WITHOUT redeploying, so before
 * this the promoted node kept the value it was DEPLOYED with — `standby` — and
 * silently stopped taking base backups (both tiers) and archiving WAL (compose,
 * and k8s too once its archive wrapper regained the write-guard).
 *
 * The subtle half is that `WALG_ROLE` is CONTAINER ENVIRONMENT, fixed at
 * container-create time. Writing `.env` or patching a StatefulSet is not the
 * fix on its own; the container has to be recreated. These tests pin the two
 * builders that make that happen, and — the part most likely to rot — pin the
 * compose `-f` reconstruction against the ONE list `composeFileFlags` is built
 * from, so a newly added overlay cannot reach deploy and miss failover.
 */
import { describe, expect, it } from 'vitest';
import { REPL_COMPOSE_FLAGS } from '../../../src/lib/deploy/compose/ha.js';
import {
  composeDbRecreateShell,
  k8sDbRolloutStatusArgv,
  k8sSetWalgRoleArgv,
  WALG_DB_STATEFULSET,
  WALG_ROLE_ENV,
  walgRoleDegradedMessage,
} from '../../../src/lib/deploy/walg-role.js';

const shell = composeDbRecreateShell('/opt/myapp');

describe('composeDbRecreateShell', () => {
  it('recreates ONLY the db service, in the project directory', () => {
    expect(shell).toContain('cd /opt/myapp');
    expect(shell).toContain('up -d --no-deps db');
    // --no-deps: nothing else on the node is touched. In particular the app
    // tier is not restarted out from under the caller (compose failover
    // restarts it itself, immediately after, so it re-pools against the
    // recreated database).
    expect(shell).not.toContain('--remove-orphans');
  });

  it('never bare-`up`s: prod.yml would be dropped and the db recreated with dev config', () => {
    expect(shell).toContain('FLAGS="-f docker-compose.yml -f docker-compose.prod.yml"');
    expect(shell).toContain('docker compose $FLAGS up -d --no-deps db');
  });

  // GROUND TRUTH over inference: the label is literally the -f set the running
  // container was created with, so it beats reconstructing that set by probing.
  it('prefers the compose config_files label, read BEFORE the recreate overwrites it', () => {
    expect(shell).toContain('com.docker.compose.project.config_files');
    const labelIdx = shell.indexOf('com.docker.compose.project.config_files');
    const upIdx = shell.indexOf('up -d --no-deps db');
    expect(labelIdx).toBeLessThan(upIdx);
  });

  // The failure mode this whole function guards against IS the empty -f set (a
  // bare `up` resolves docker-compose.yml alone). So a missing/garbage label
  // must degrade to the probe reconstruction, never to nothing.
  it('degrades a missing or unusable label to the PROBE set, never to an empty -f set', () => {
    // The label branch only wins when it produced something file-shaped…
    expect(shell).toMatch(/case "\$FLAGS" in\n\s*\*\.yml\*\|\*\.yaml\*\)/);
    // …and the fallback arm always seeds the base pair before probing.
    const caseStart = shell.indexOf('case "$FLAGS" in');
    const fallbackArm = shell.slice(caseStart, shell.indexOf('esac', caseStart));
    expect(fallbackArm).toContain('FLAGS="-f docker-compose.yml -f docker-compose.prod.yml"');
    expect(fallbackArm).toContain('rebuilt the -f set from the replication file set');
    // An all-whitespace / empty label field never contributes a bare `-f`.
    expect(shell).toContain('case "$f" in *[!\\ ]*) FLAGS="$FLAGS -f $f" ;; esac');
  });

  // Measured, not theorised: against a real 3-file project a bare
  // `up -d --no-deps db` reported `Container … Started` and left
  // .NetworkSettings.Ports as {} — the 5433 publish vanished silently.
  it('asserts the published-port set SURVIVES the recreate, and fails loudly if not', () => {
    expect(shell).toContain('PORTS_BEFORE=');
    expect(shell).toContain('PORTS_AFTER=');
    // Captured before, compared after.
    expect(shell.indexOf('PORTS_BEFORE=')).toBeLessThan(shell.indexOf('up -d --no-deps db'));
    expect(shell.indexOf('up -d --no-deps db')).toBeLessThan(shell.indexOf('PORTS_AFTER='));
    expect(shell).toContain('DROPPED published port(s)');
    // Only PUBLISHED ports are compared — exposed-but-unpublished ports have a
    // null mapping, so `range` over them yields nothing and cannot false-fail.
    expect(shell).toContain('{{range $p, $c := .NetworkSettings.Ports}}');
  });

  it('the drop message states the node is recoverable and names the remedy', () => {
    // Read mid-incident: the db IS up (the recreate worked, it just resolved the
    // wrong file set), so say so before saying what is wrong, and give the one
    // command that reconciles it — same remedy as walgRoleDegradedMessage.
    expect(shell).toContain('the database is RUNNING');
    expect(shell).toContain('Nothing is lost');
    expect(shell).toContain('vibecarbon deploy <env>');
  });

  it('refuses to recreate when no db container is running, rather than guessing', () => {
    // Without a running container there is no label and no port baseline, so
    // the assertion below would be vacuous and the -f set unverifiable.
    expect(shell).toContain('refusing to recreate blind');
  });

  it('appends the replication overlay LAST, exactly as reconcile.sh does', () => {
    // Dropping it recreates db without the 5433 publish the repl-gateway socat
    // relay dials — replication transport silently dies.
    expect(shell).toContain('docker-compose.replication.yml');
    const files = [...shell.matchAll(/docker-compose[\w.]*\.yml/g)].map((m) => m[0]);
    expect(files.at(-1)).toBe('docker-compose.replication.yml');
  });

  // DRIFT GUARD — the fallback set must equal the set the DEPLOY itself uses
  // when it recreates db on a compose-ha node (`haWriteReplicationOverlay` →
  // REPL_COMPOSE_FLAGS). Not "every overlay present on the node": n8n and
  // metabase both define a `db:` key, so a generous fallback would merge config
  // the deploy never applied — and the port assertion could not catch it,
  // because it only detects REMOVALS.
  it('falls back to exactly REPL_COMPOSE_FLAGS — never to every overlay present', () => {
    const replFiles = REPL_COMPOSE_FLAGS.split(' ').filter((t) => t !== '-f');
    const caseStart = shell.indexOf('case "$FLAGS" in');
    const fallbackArm = shell.slice(caseStart, shell.indexOf('esac', caseStart));
    const referenced = [...fallbackArm.matchAll(/docker-compose[\w.]*\.yml/g)].map((m) => m[0]);
    expect([...new Set(referenced)]).toEqual(replFiles);
    // And nothing anywhere in the script reaches for an add-on overlay.
    for (const f of ['n8n', 'metabase', 'redis', 'observability', 'dns01']) {
      expect(shell, `fallback must not pull in docker-compose.${f}.yml`).not.toContain(
        `docker-compose.${f}`,
      );
    }
  });

  it('waits for postgres to answer again — `up -d` returns on CREATE, not on ready', () => {
    expect(shell).toContain('pg_isready');
    // Everything downstream (the audit, the app-tier restart) needs a database
    // that answers, so a db that never comes back has to be a hard failure.
    expect(shell.trimEnd().endsWith('exit 1')).toBe(true);
    expect(shell).toContain('set -e');
  });

  it('reports the resulting WALG_ROLE, so the log shows what the container actually got', () => {
    expect(shell).toContain(`printenv ${WALG_ROLE_ENV}`);
  });

  it('never lets a file test short-circuit the recreate under `set -e`', () => {
    // `[ -f x ] && FLAGS=…` evaluates to non-zero when the file is ABSENT —
    // which, as the last statement of the branch under `set -e`, aborts the
    // script before the `up` ever runs. A single-server node legitimately has
    // no replication overlay, so that is the common case, not the rare one.
    expect(shell).toMatch(/if \[ -f docker-compose\.replication\.yml \]; then/);
    expect(shell).not.toMatch(/\[ -f [^\]]+\] &&/);
  });
});

describe('k8s write-guard patch', () => {
  it('sets WALG_ROLE on the supabase-db StatefulSet', () => {
    expect(k8sSetWalgRoleArgv('primary')).toEqual([
      '-n',
      'vibecarbon',
      'set',
      'env',
      `statefulset/${WALG_DB_STATEFULSET}`,
      'WALG_ROLE=primary',
    ]);
    expect(k8sSetWalgRoleArgv('standby').at(-1)).toBe('WALG_ROLE=standby');
  });

  it('targets the StatefulSet, not the pod — a pod patch would be lost on the next roll', () => {
    expect(k8sSetWalgRoleArgv('primary')).not.toContain(`${WALG_DB_STATEFULSET}-0`);
  });

  it('waits for the rollout, because the audit that follows reads the RUNNING pod', () => {
    expect(k8sDbRolloutStatusArgv(300)).toEqual([
      '-n',
      'vibecarbon',
      'rollout',
      'status',
      `statefulset/${WALG_DB_STATEFULSET}`,
      '--timeout=300s',
    ]);
  });
});

describe('walgRoleDegradedMessage', () => {
  const msg = walgRoleDegradedMessage({
    path: 'compose',
    envName: 'prod',
    promotedIp: '2.2.2.2',
    detail: 'the db container still has WALG_ROLE=standby',
  });

  it('states the world first — this is read mid-incident', () => {
    // The first question during a failover is "am I serving?", so answer it
    // before describing the problem.
    expect(msg.indexOf('is serving')).toBeLessThan(msg.indexOf('could not prove'));
    expect(msg).toContain('FAILOVER COMPLETED, BACKUPS DID NOT');
  });

  it('names the consequence and the one-command check', () => {
    expect(msg).toContain('ONLY live copy');
    expect(msg).toContain('printenv WALG_ROLE');
    expect(msg).toContain('vibecarbon deploy prod');
  });

  it('gives the k8s check on the k8s path', () => {
    const k8s = walgRoleDegradedMessage({
      path: 'k8s',
      envName: 'prod',
      promotedIp: '3.3.3.3',
      detail: 'x',
    });
    expect(k8s).toContain(`kubectl -n vibecarbon exec ${WALG_DB_STATEFULSET}-0`);
  });
});
