/**
 * Moving the wal-g WRITE-GUARD during failover.
 *
 * `WALG_ROLE` is rendered once, at deploy time, from the deploy's notion of
 * which node is which. Failover moves the role WITHOUT redeploying, so before
 * this the promoted node kept the value it was DEPLOYED with (`standby`) and
 * silently stopped taking base backups (both tiers) and archiving WAL (compose,
 * and k8s too once its archive wrapper regained the write-guard).
 *
 * The subtle half is that `WALG_ROLE` is CONTAINER ENVIRONMENT, fixed at
 * container-create time. Writing `.env` or patching a StatefulSet is not the
 * fix on its own; the container has to be recreated. These tests pin the two
 * builders that make that happen. The compose recreate runs vc-compose, the
 * node's own `-f` set (tests/unit/deploy/vc-compose.test.ts), so it is run
 * here against the real script and a stub `docker`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPOSE_REPLICATION_OVERLAY } from '../../../src/lib/deploy/compose/command.js';
import { DB_POD, DB_STATEFULSET } from '../../../src/lib/deploy/db-workload.js';
import {
  composeDbRecreateShell,
  k8sDbRolloutStatusArgv,
  k8sSetWalgRoleArgv,
  WALG_ROLE_ENV,
  walgRoleDegradedMessage,
} from '../../../src/lib/deploy/walg-role.js';
import {
  DROP_COMPOSE_FILES_SH,
  SERVER_BASE_FLAGS,
  writeVcCompose,
} from '../../_shared/vc-compose-stub.js';

const shell = composeDbRecreateShell('/opt/myapp');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Run the recreate in a stand-in compose-ha node: the real vc-compose (and the
 * replication overlay unless `overlay: false`), and a `docker` that answers
 * ps/inspect/up/exec. `portsAfter` is what the recreated container publishes.
 */
function recreate({
  overlay = true,
  dbRunning = true,
  portsAfter = '5432/tcp->5433 ',
}: {
  overlay?: boolean;
  dbRunning?: boolean;
  portsAfter?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-walg-role-'));
  dirs.push(dir);
  writeVcCompose(dir);
  if (overlay) writeFileSync(join(dir, COMPOSE_REPLICATION_OVERLAY), 'services: {}\n');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
echo "RAW $*" >> "${dir}/calls"
${DROP_COMPOSE_FILES_SH}case "$*" in
  "compose ps -q db") ${dbRunning ? 'echo dbcid' : ':'} ;;
  "inspect -f "*)
    if [ -f "${dir}/inspected" ]; then printf '%s' '${portsAfter}'; else touch "${dir}/inspected"; printf '%s' '5432/tcp->5433 '; fi ;;
  "compose exec -T db printenv ${WALG_ROLE_ENV}") echo primary ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const r = spawnSync('bash', ['-c', composeDbRecreateShell(dir)], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const calls = readFileSync(join(dir, 'calls'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/^RAW /, ''));
  return { ...r, calls };
}

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

  it('never bare-`up`s: it runs vc-compose, so prod.yml is never dropped', () => {
    expect(shell).toContain('sh vc-compose up -d --no-deps db');
    expect(shell).not.toMatch(/\bdocker compose\b/);
  });

  it('on a compose-ha node, recreates db from the node set WITH the replication overlay', () => {
    const r = recreate();
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain(
      `compose ${SERVER_BASE_FLAGS} -f ${COMPOSE_REPLICATION_OVERLAY} up -d --no-deps db`,
    );
    // Every compose call it made went through the same set.
    for (const c of r.calls.filter((l) => l.startsWith('compose '))) {
      expect(c, c).toContain(`${SERVER_BASE_FLAGS} -f ${COMPOSE_REPLICATION_OVERLAY} `);
    }
  });

  // Measured, not theorised: against a real 3-file project a bare
  // `up -d --no-deps db` reported `Container … Started` and left
  // .NetworkSettings.Ports as {}: the 5433 publish vanished silently.
  it('asserts the published-port set SURVIVES the recreate, and fails loudly if not', () => {
    const r = recreate({ portsAfter: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DROPPED published port(s): 5432/tcp->5433');
    // Captured before, compared after.
    expect(shell.indexOf('PORTS_BEFORE=')).toBeLessThan(shell.indexOf('up -d --no-deps db'));
    expect(shell.indexOf('up -d --no-deps db')).toBeLessThan(shell.indexOf('PORTS_AFTER='));
    // Only PUBLISHED ports are compared: exposed-but-unpublished ports have a
    // null mapping, so `range` over them yields nothing and cannot false-fail.
    expect(shell).toContain('{{range $p, $c := .NetworkSettings.Ports}}');
  });

  it('the drop message states the node is recoverable and names the remedy', () => {
    // Read mid-incident: the db IS up (the recreate worked, it just lost a
    // publish), so say so before saying what is wrong, and give the one command
    // that reconciles it: same remedy as walgRoleDegradedMessage.
    const r = recreate({ portsAfter: '' });
    expect(r.stderr).toContain('the database is RUNNING');
    expect(r.stderr).toContain('Nothing is lost');
    expect(r.stderr).toContain('vibecarbon deploy <env>');
  });

  it('refuses to recreate when no db container is running, rather than guessing', () => {
    const r = recreate({ dbRunning: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to recreate blind');
    expect(r.calls.some((c) => c.includes(' up '))).toBe(false);
  });

  it('a node without the overlay (single compose) recreates from the base set alone', () => {
    const r = recreate({ overlay: false });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain(`compose ${SERVER_BASE_FLAGS} up -d --no-deps db`);
  });

  it('waits for postgres to answer again: `up -d` returns on CREATE, not on ready', () => {
    expect(shell).toContain('pg_isready');
    // Everything downstream (the audit, the app-tier restart) needs a database
    // that answers, so a db that never comes back has to be a hard failure.
    expect(shell.trimEnd().endsWith('exit 1')).toBe(true);
    expect(shell).toContain('set -e');
  });

  it('reports the resulting WALG_ROLE, so the log shows what the container actually got', () => {
    expect(shell).toContain(`printenv ${WALG_ROLE_ENV}`);
    expect(recreate().stdout).toContain(`${WALG_ROLE_ENV}=primary`);
  });
});

describe('k8s write-guard patch', () => {
  it('sets WALG_ROLE on the db StatefulSet', () => {
    expect(k8sSetWalgRoleArgv('primary')).toEqual([
      '-n',
      'vibecarbon',
      'set',
      'env',
      `statefulset/${DB_STATEFULSET}`,
      'WALG_ROLE=primary',
    ]);
    expect(k8sSetWalgRoleArgv('standby').at(-1)).toBe('WALG_ROLE=standby');
  });

  it('targets the StatefulSet, not the pod — a pod patch would be lost on the next roll', () => {
    expect(k8sSetWalgRoleArgv('primary')).not.toContain(DB_POD);
  });

  it('waits for the rollout, because the audit that follows reads the RUNNING pod', () => {
    expect(k8sDbRolloutStatusArgv(300)).toEqual([
      '-n',
      'vibecarbon',
      'rollout',
      'status',
      `statefulset/${DB_STATEFULSET}`,
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

  it('names the base backup the failover could not push on the new timeline (one error, not two)', () => {
    expect(msg).toContain('no base backup on the new timeline');
    expect(msg).toContain('`vibecarbon backup prod`');
  });

  it('names the add-ons the next reconcile holds at zero only when it is given them', () => {
    expect(msg).not.toContain('next reconcile');
    const held = walgRoleDegradedMessage({
      path: 'compose',
      envName: 'prod',
      promotedIp: '2.2.2.2',
      detail: 'x',
      heldAtZero: ['n8n', 'metabase'],
    });
    expect(held).toContain(
      "Until WALG_ROLE=primary is in the new primary's .env, its next reconcile scales n8n, metabase back to 0",
    );
    expect(held).not.toMatch(/\u2014/);
  });

  it('gives the k8s check on the k8s path', () => {
    const k8s = walgRoleDegradedMessage({
      path: 'k8s',
      envName: 'prod',
      promotedIp: '3.3.3.3',
      detail: 'x',
    });
    expect(k8s).toContain(`kubectl -n vibecarbon exec ${DB_POD}`);
  });
});
