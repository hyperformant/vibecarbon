/**
 * The host reporter on real Ubuntu 26.04 (the release every provider boots):
 * compose mode (no k3s), the `since` stamp, `--print`, and that every package
 * Ubuntu's own maintainer scripts flag as reboot-required matches
 * REBOOT_TRIGGER_PATTERNS.
 *
 * The container is named vctest-* and removed in afterAll.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostReporterScript } from '../../../src/lib/host-reporter.js';
import { parseHostState, REBOOT_TRIGGER_PATTERNS } from '../../../src/lib/host-state.js';

const SKIPPED =
  process.env.DOCKER_INTEGRATION === 'true'
    ? null
    : 'skipped: needs Docker; run it with DOCKER_INTEGRATION=true (pnpm test:docker)';
if (SKIPPED) console.info(`host-reporter-ubuntu: ${SKIPPED}`);

const NAME = `vctest-hostrep-ubuntu-${process.pid}`;
const LONG = 240_000;
const STATE = '/run/vibecarbon-host/state.json';

const run = (cmd: string, args: string[], timeout = LONG) =>
  spawnSync(cmd, args, { encoding: 'utf-8', timeout });
const sh = (script: string) => run('docker', ['exec', NAME, 'sh', '-c', script]);

describe.skipIf(SKIPPED)('the host reporter on Ubuntu 26.04 (compose mode)', () => {
  let tmp = '';

  beforeAll(() => {
    const up = run('docker', ['run', '-d', '--name', NAME, 'ubuntu:26.04', 'sleep', '3600']);
    if (up.status !== 0) throw new Error(`docker run failed: ${up.stderr.trim()}`);
    const apt = sh(
      'export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=60 update -qq && apt-get -o DPkg::Lock::Timeout=60 install -y -qq unattended-upgrades >/dev/null',
    );
    if (apt.status !== 0) throw new Error(`apt failed: ${apt.stderr.trim()}`);
    tmp = mkdtempSync(join(tmpdir(), 'vctest-hostrep-'));
    const file = join(tmp, 'host-reporter.sh');
    writeFileSync(file, hostReporterScript());
    const cp = run('docker', ['cp', file, `${NAME}:/tmp/host-reporter.sh`]);
    if (cp.status !== 0) throw new Error(`docker cp failed: ${cp.stderr.trim()}`);
  }, LONG);

  afterAll(() => {
    run('docker', ['rm', '-f', '-v', NAME]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('writes rebootRequired false with no restart pending', () => {
    const r = sh('sh /tmp/host-reporter.sh');
    expect(r.status, r.stderr).toBe(0);
    const state = parseHostState(sh(`cat ${STATE}`).stdout);
    expect(state).toMatchObject({ rebootRequired: false, since: null, packages: [] });
  });

  it('writes rebootRequired true with a since stamp once the files exist', () => {
    sh(
      'echo linux-image-e2e-test > /var/run/reboot-required.pkgs && touch /var/run/reboot-required',
    );
    const r = sh('sh /tmp/host-reporter.sh');
    expect(r.status, r.stderr).toBe(0);
    const state = parseHostState(sh(`cat ${STATE}`).stdout);
    expect(state?.rebootRequired).toBe(true);
    expect(state?.since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(state?.packages).toEqual(['linux-image-e2e-test']);
  });

  it('--print prints the same JSON and writes nothing', () => {
    const before = sh(`stat -c %Y.%y ${STATE}`).stdout;
    const printed = sh('sh /tmp/host-reporter.sh --print');
    expect(printed.status, printed.stderr).toBe(0);
    expect(parseHostState(printed.stdout)).toEqual(parseHostState(sh(`cat ${STATE}`).stdout));
    expect(sh(`stat -c %Y.%y ${STATE}`).stdout).toBe(before);
  });

  it('on a k3s node without its kubeconfig it fails and writes no compose state (systemd retries)', () => {
    sh(`rm -rf /run/vibecarbon-host /var/lib/rancher/k3s/agent/kubelet.kubeconfig`);
    sh('printf "#!/bin/sh\\nexit 0\\n" > /usr/local/bin/k3s && chmod 755 /usr/local/bin/k3s');
    try {
      const r = sh('sh /tmp/host-reporter.sh');
      expect(r.status).not.toBe(0);
      expect(sh(`test -e ${STATE}`).status).not.toBe(0);
    } finally {
      sh('rm -f /usr/local/bin/k3s');
    }
  });

  it('every package Ubuntu flags with notify-reboot-required matches the trigger patterns', () => {
    const r = sh('grep -l notify-reboot-required /var/lib/dpkg/info/*.postinst');
    const pkgs = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((f) =>
        f
          .replace(/^.*\//, '')
          .replace(/\.postinst$/, '')
          .replace(/:.*$/, ''),
      );
    console.info(`notify-reboot-required packages: ${pkgs.join(' ')}`);
    expect(pkgs.length).toBeGreaterThan(0);
    const unmatched = pkgs.filter((p) => !REBOOT_TRIGGER_PATTERNS.some((re) => re.test(p)));
    expect(unmatched).toEqual([]);
  });
});
