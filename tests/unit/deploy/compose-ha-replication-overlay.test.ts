import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderReconcileScript } from '../../../src/lib/deploy/bundle.js';
import { COMPOSE_REPLICATION_OVERLAY } from '../../../src/lib/deploy/compose/command.js';
import { SERVER_BASE_FLAGS, writeVcCompose } from '../../_shared/vc-compose-stub.js';

// ---------------------------------------------------------------------------
// compose-ha replication overlay (5433) preservation in reconcile.sh
//
// On a compose-ha server, docker-compose.replication.yml maps db:5432 →
// host:5433 so pg_basebackup and streaming replication can reach raw
// postgres. Any `up -d` that omits the overlay recreates the db container
// WITHOUT the 5433 mapping, silently dropping the replication listener.
//
// reconcile.sh runs every Compose call through vc-compose, which appends the
// overlay at runtime when the file is present (compose-ha writes it after the
// bundle lands). On single-server compose the file never exists: a no-op.
// Run here against the real vc-compose and a stub `docker`.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function reconcile({ overlay, isFast }: { overlay: boolean; isFast: boolean }): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'vc-reconcile-repl-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'reconcile.sh'), renderReconcileScript('myapp', isFast));
  writeVcCompose(dir);
  if (overlay) writeFileSync(join(dir, COMPOSE_REPLICATION_OVERLAY), 'services: {}\n');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh
case "$1" in compose) echo "$*" >> "${dir}/calls" ;; esac
exit 0
`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const r = spawnSync('bash', ['reconcile.sh'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VC_PROJECT_DIR: dir },
  });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(join(dir, 'calls'), 'utf-8').split('\n').filter(Boolean);
}

const WITH_OVERLAY = `compose ${SERVER_BASE_FLAGS} -f ${COMPOSE_REPLICATION_OVERLAY} `;

describe('reconcile.sh keeps the replication overlay on a compose-ha node', () => {
  it('the up carries the overlay, after the static flags', () => {
    const calls = reconcile({ overlay: true, isFast: true });
    const up = calls.find((c) => c.includes(' up -d '));
    expect(up?.startsWith(WITH_OVERLAY), up).toBe(true);
  });

  it('the pull (non-fast mode), the config read and the up all carry it', () => {
    const calls = reconcile({ overlay: true, isFast: false });
    expect(calls.some((c) => c.includes(' pull '))).toBe(true);
    expect(calls.some((c) => c.includes(' config'))).toBe(true);
    for (const c of calls) expect(c.startsWith(WITH_OVERLAY), c).toBe(true);
  });

  it('fast mode skips the pull, but the up still carries the overlay', () => {
    const calls = reconcile({ overlay: true, isFast: true });
    expect(calls.some((c) => c.includes(' pull '))).toBe(false);
    expect(calls.every((c) => c.startsWith(WITH_OVERLAY))).toBe(true);
  });

  it('a single compose server (no overlay file) runs the static set alone', () => {
    const calls = reconcile({ overlay: false, isFast: false });
    for (const c of calls) expect(c, c).not.toContain(COMPOSE_REPLICATION_OVERLAY);
  });

  it('still runs set -e and the standard reconcile steps', () => {
    const script = renderReconcileScript('myapp');
    expect(script).toContain('set -e');
    expect(script).toContain('up -d --remove-orphans');
    expect(script).toContain('Reconciliation complete.');
  });
});
