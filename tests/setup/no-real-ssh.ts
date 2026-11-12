/**
 * The unit tier never reaches a real server. A test whose code under test runs
 * a real `ssh`, `scp` or `ssh-keyscan` depends on the machine's DNS and network:
 * scale-under-lineage-mark.test.ts ran `ssh root@null` for months, which fails
 * at once on a laptop and stalled past the 5 s test timeout on a GitHub runner
 * while its resolver was slow. A real ssh also writes a control socket under
 * ~/.vibecarbon.
 *
 * So each unit test runs with PATH starting at a directory whose `ssh`, `scp`
 * and `ssh-keyscan` record the call and fail at once, and a test that ran one
 * fails, naming the command. Stub the step that runs it instead (sshRun,
 * sshRunAsync, or the module that calls them).
 *
 * A test that needs ssh's process behaviour (a child the wrapper timer kills,
 * ssh's own failure line) puts a stand-in of its own first on PATH, as
 * compose-ssh-timeout-retry.test.ts and e2e/ssh-reachability.test.ts do.
 *
 * The log path is written into each script, not passed in the environment, so
 * a command spawned with a scrubbed or rebuilt env (cleanEnv, an explicit env)
 * still records, as long as that env keeps PATH.
 * global-setup.ts puts process.env back after every test, so PATH is set again
 * before each one. The scripts live in this file's temp root beside the census
 * dir, not in it (like global-setup.ts's uplink and fpkey dirs), so the temp
 * census and a test's own tempLeftovers never see them, and the root's removal
 * takes them.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

const SHIMMED = ['ssh', 'scp', 'ssh-keyscan'];

// global-setup.ts runs first and points TMPDIR at <file root>/tmp.
const fileRoot = dirname(tmpdir());
if (!basename(fileRoot).startsWith('vc-test-')) {
  throw new Error(
    `no-real-ssh.ts runs after global-setup.ts, which points TMPDIR into a vc-test- root; ` +
      `TMPDIR is ${tmpdir()} here`,
  );
}
const binDir = join(fileRoot, 'no-real-ssh');
mkdirSync(binDir);
const log = join(binDir, 'calls.log');
writeFileSync(log, '');
for (const name of SHIMMED) {
  const script = join(binDir, name);
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `printf '%s %.200s\\n' '${name}' "$*" >> '${log}'`,
      `echo '${name}: a unit test never runs a real ${name} (tests/setup/no-real-ssh.ts)' >&2`,
      'exit 255',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
}

beforeEach(() => {
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
});

afterEach(() => {
  const calls = readFileSync(log, 'utf8').trim();
  if (!calls) return;
  writeFileSync(log, '');
  throw new Error(
    `This test ran a real ssh command, which the unit tier never does (tests/setup/no-real-ssh.ts). ` +
      `Stub the step that runs it. Calls:\n${calls}`,
  );
});
