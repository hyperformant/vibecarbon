/**
 * The systemd unit is the ONLY unattended whole-stack recreate path (node
 * reboot / systemctl restart). 2026-07-16 audit: it was baked with the static
 * compose flags and NO replication overlay, so a compose-ha node reboot
 * recreated db without the 5433 publish and --remove-orphans deleted
 * repl-gateway (defined only in the overlay), silently breaking replication
 * transport until the next deploy. The unit runs vc-compose, like
 * reconcile.sh, which adds the overlay when the node has it; the standby-scale
 * fragment is escaped for systemd ($$ → literal $, verified on systemd 255,
 * the Ubuntu 24.04 node version; nodes now run 259).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSystemdUnit } from '../../../src/lib/deploy/bundle.js';
import {
  COMPOSE_REPLICATION_OVERLAY,
  VC_COMPOSE,
} from '../../../src/lib/deploy/compose/command.js';
import { SERVER_BASE_FLAGS, writeVcCompose } from '../../_shared/vc-compose-stub.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The command line of an Exec*= key, as systemd hands it to bash (`$$` → `$`). */
function execLine(unit: string, key: 'ExecStart' | 'ExecStop'): string {
  const line = unit.split('\n').find((l) => l.startsWith(`${key}=`)) ?? '';
  const m = /^\S+=\/bin\/bash -c '(.*)'$/.exec(line);
  return (m?.[1] ?? '').replaceAll('$$', '$');
}

/** Run an Exec line in a stand-in project dir; returns the docker argv. */
function runExec(command: string, { overlay }: { overlay: boolean }): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'vc-unit-'));
  dirs.push(dir);
  writeVcCompose(dir);
  if (overlay) writeFileSync(join(dir, COMPOSE_REPLICATION_OVERLAY), 'services: {}\n');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${dir}/argv"\n`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const r = spawnSync('bash', ['-c', command], {
    cwd: dir, // WorkingDirectory=
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(join(dir, 'argv'), 'utf-8').trim().split('\n');
}

describe('renderSystemdUnit', () => {
  const unit = renderSystemdUnit('myproj');

  it('ExecStart and ExecStop run vc-compose', () => {
    expect(execLine(unit, 'ExecStart')).toMatch(
      new RegExp(`^${VC_COMPOSE} up -d --remove-orphans \\$\\(\\[ -f standby-scale\\.sh \\]`),
    );
    expect(execLine(unit, 'ExecStop')).toBe(`${VC_COMPOSE} down`);
  });

  it('a compose-ha node reboot recreates the stack WITH the replication overlay', () => {
    const argv = runExec(execLine(unit, 'ExecStart'), { overlay: true });
    expect(argv.slice(0, 7)).toEqual([
      'compose',
      ...SERVER_BASE_FLAGS.split(' '),
      '-f',
      COMPOSE_REPLICATION_OVERLAY,
    ]);
    expect(argv.slice(7)).toEqual(['up', '-d', '--remove-orphans']);
    expect(runExec(execLine(unit, 'ExecStop'), { overlay: true })).toContain(
      COMPOSE_REPLICATION_OVERLAY,
    );
  });

  it('a single compose server (no overlay) gets the baked set alone', () => {
    expect(runExec(execLine(unit, 'ExecStart'), { overlay: false })).not.toContain(
      COMPOSE_REPLICATION_OVERLAY,
    );
  });

  it('escapes every command substitution as $$ (a single $ is eaten by systemd expansion)', () => {
    // Any `$(` not preceded by `$` would reach systemd unescaped.
    expect(unit).not.toMatch(/[^$]\$\(/);
  });

  it('runs from the project dir, where vc-compose and the overlay test resolve', () => {
    expect(unit).toContain('WorkingDirectory=/opt/myproj');
  });
});
