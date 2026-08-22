import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnAndCapture } from '../../../tests/e2e/utils/cli-runner.js';

// Regression coverage for the orphan-grandchild hang observed on
// e2e compose-ha 2026-05-12: vibecarbon create spawned pnpm install,
// the parent CLI exited, pnpm was reparented to init and kept stdout/stderr
// open, and spawnAndCapture's previous use of `child.on('close')` hung the
// runner for 33 min before manual SIGKILL.
//
// The fix: spawn detached so the child leads a process group, kill the
// whole group on timeout, and resolve on `'exit'` (not `'close'`) so an
// orphan holding stdio cannot stall completion.

describe('spawnAndCapture', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cli-runner-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('resolves on process exit even when an orphan grandchild keeps stdio open', async () => {
    // Parent script spawns a detached `sleep` whose stdout/stderr are
    // inherited from the parent's piped FDs. The parent exits immediately;
    // the sleep keeps the FDs alive for 30s. Pre-fix, `child.on('close')`
    // never fired because the sleep held the pipes.
    const parentScript = join(workDir, 'parent.sh');
    writeFileSync(
      parentScript,
      [
        '#!/usr/bin/env bash',
        'echo "parent: started"',
        // Spawn sleep with stdio inherited from this shell, then exit.
        // The sleep continues running, holding stdout/stderr open.
        'sleep 30 &',
        'echo "parent: backgrounded sleep $!, exiting"',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );

    const start = performance.now();
    const result = await spawnAndCapture('/usr/bin/env', ['bash', parentScript], {
      cwd: workDir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
      commandLabel: 'orphan-test',
      start,
    });
    const elapsed = performance.now() - start;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('parent: started');
    expect(result.stdout).toContain('parent: backgrounded sleep');
    // Process exited in <1s; must not block for the full 30s the orphan
    // would otherwise live, and must not need the 10s timeout to fire.
    expect(elapsed).toBeLessThan(3_000);
  }, 15_000);

  it('SIGKILLs the entire process group on timeout', async () => {
    // Parent spawns a long-running grandchild and waits on it. Without
    // group-targeted kill, `child.kill('SIGKILL')` reaps only the parent
    // shell, leaving the grandchild alive (the bug). With the fix, the
    // negative-pid SIGKILL takes out the group.
    const parentScript = join(workDir, 'parent.sh');
    const sentinel = join(workDir, 'grandchild.pid');
    writeFileSync(
      parentScript,
      [
        '#!/usr/bin/env bash',
        // Long sleep — much longer than the test's timeoutMs.
        'sleep 120 &',
        'GRANDCHILD=$!',
        `echo "$GRANDCHILD" > ${sentinel}`,
        'wait "$GRANDCHILD"',
      ].join('\n'),
      { mode: 0o755 },
    );

    const start = performance.now();
    const result = await spawnAndCapture('/usr/bin/env', ['bash', parentScript], {
      cwd: workDir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 2_000,
      commandLabel: 'group-kill-test',
      start,
    });

    // Timeout fires → SIGKILL'd, surface as exitCode 1.
    expect(result.exitCode).toBe(1);

    // Grandchild PID written before timeout fired. Verify it's gone.
    const fs = await import('node:fs/promises');
    const grandPid = Number((await fs.readFile(sentinel, 'utf-8')).trim());
    expect(Number.isFinite(grandPid)).toBe(true);

    // Give the kernel a tick to reap the process group.
    await new Promise((r) => setTimeout(r, 200));

    // `kill -0` returns 0 if the process exists, non-zero otherwise.
    const check = spawnSync('kill', ['-0', String(grandPid)]);
    expect(check.status).not.toBe(0);
  }, 10_000);
});
