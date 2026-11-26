/**
 * carbon/cloud-init/k3s/_host-firewall-off.sh, run under bash with a fake
 * `ufw`. Vultr's Ubuntu image boots with UFW active, and left on it drops the
 * cluster's own traffic and ingress; the cloud firewall group is the node's
 * filter. PATH holds only the fake directory, so the host's own ufw can never
 * run.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const INCLUDE = readRepoFile('carbon/cloud-init/k3s/_host-firewall-off.sh');

let tmp = '';
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

/** Run the include under the boot scripts' shell options. null: no ufw at all. */
function run(ufwExit: number | null) {
  tmp = createTempDir('vc-host-firewall-');
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const log = join(tmp, 'ufw-calls');
  if (ufwExit !== null) {
    writeFileSync(join(bin, 'ufw'), `#!/bin/sh\necho "$*" >> ${log}\nexit ${ufwExit}\n`);
    chmodSync(join(bin, 'ufw'), 0o755);
  }
  const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${INCLUDE}\necho after`], {
    env: { PATH: bin, HOME: tmp },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

describe('_host-firewall-off.sh (executed)', () => {
  it('no ufw on the image: a no-op', () => {
    const r = run(null);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('after\n');
    expect(r.stderr).toBe('');
  });

  it('ufw present: disables it, without a prompt, and carries on', () => {
    const r = run(0);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['--force disable']);
    expect(r.stdout).toContain('UFW disabled');
    expect(r.stdout).toMatch(/after\n$/);
  });

  it('ufw that cannot be disabled: FATAL, and the boot stops', () => {
    const r = run(1);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(['--force disable']);
    expect(r.stderr).toContain(
      "FATAL: could not disable UFW; left on, it drops the cluster's own traffic",
    );
    expect(r.stdout).not.toContain('after');
  });
});
