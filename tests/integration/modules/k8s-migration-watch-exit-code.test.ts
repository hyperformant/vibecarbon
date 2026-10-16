/**
 * The k8s migration watch (lib/deploy/k8s/readiness.js
 * watchAppMigrationFailure) tells a failed migration from "not ready yet" by
 * the probe's exit code, which reaches it as `err.status` from
 * runCommandAsync. Unit tests inject `exec`, so they never prove that hop.
 * This drives the REAL default exec against a stand-in `kubectl` on PATH that
 * exits the way `kubectl exec` does (with the in-container command's code),
 * so a change in how runCommandAsync reports exit codes fails here instead of
 * only on real infrastructure.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_PROBE_EXIT } from '../../../src/lib/deploy/admin-ready.js';
import { watchAppMigrationFailure } from '../../../src/lib/deploy/k8s/readiness.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A `kubectl` whose `exec` exits `code` and whose `logs` prints a tail. */
function fakeKubectl(code: number) {
  dir = mkdtempSync(join(tmpdir(), 'vc-kubectl-'));
  const bin = join(dir, 'kubectl');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  if [ "$a" = logs ]; then echo "migration 0003 failed: relation exists"; exit 0; fi',
      'done',
      `exit ${code}`,
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { ...process.env, PATH: `${dir}:${process.env.PATH}` };
}

describe('watchAppMigrationFailure with the real exec', () => {
  it('a probe exit of MIGRATIONS_FAILED rejects at once with the log tail', async () => {
    const env = fakeKubectl(ADMIN_PROBE_EXIT.MIGRATIONS_FAILED);
    const controller = new AbortController();
    // A watch that misreads the code keeps polling: stop it so this fails
    // (resolves instead of rejecting) rather than hanging.
    const stop = setTimeout(() => controller.abort(), 5_000);
    await expect(
      watchAppMigrationFailure({ env, signal: controller.signal, intervalMs: 10 }),
    ).rejects.toThrow(/migration 0003 failed: relation exists/);
    clearTimeout(stop);
  });

  it('any other failing exit keeps watching until aborted', async () => {
    const env = fakeKubectl(1);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      watchAppMigrationFailure({ env, signal: controller.signal, intervalMs: 10 }),
    ).resolves.toBeUndefined();
  });
});
