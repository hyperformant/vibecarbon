/**
 * The boot refresh: narrow to what we install, hooks silenced for that one
 * refresh only through `apt-get -c <file>` on tmpfs, so nothing is ever written
 * into apt.conf.d and a kill mid-refresh leaves nothing behind. The returned
 * shell really runs under `sh -c` with a fake `apt-get` first on PATH, plain and
 * under `set -e`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APT_LOCK_OPT,
  APT_QUIET_CONF,
  APT_TRIMMED_INDEXES,
  aptInstallOrRefresh,
  aptQuietUpdate,
  aptWaitForDailyUnits,
} from '../../../src/lib/deploy/apt.js';

const CLEARS = [
  'APT::Update::Post-Invoke-Success',
  'APT::Update::Post-Invoke',
  'APT::Update::Post-Invoke-Stats',
  'APT::Update::Pre-Invoke',
];

let dir: string;
let conf: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apt-quiet-'));
  conf = join(dir, '99zz-vibecarbon-boot');
  log = join(dir, 'calls.log');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Fake apt-get: logs each call, records whether the conf existed (and its body), exits per FAKE_RC. */
function fakeApt(rcs: number[]) {
  const script = `#!/bin/sh
n=$(cat "${dir}/n" 2>/dev/null || echo 0)
n=$((n+1)); echo $n > "${dir}/n"
if [ -f "${conf}" ]; then seen=conf; else seen=noconf; fi
echo "$seen $*" >> "${log}"
if [ -f "${conf}" ]; then cp "${conf}" "${dir}/conf.seen.$n"; fi
rc=$(echo "${rcs.join(' ')}" | cut -d' ' -f$n)
exit \${rc:-0}
`;
  writeFileSync(join(dir, 'apt-get'), script);
  chmodSync(join(dir, 'apt-get'), 0o755);
}

function run(cmd: string, setE = false) {
  const body = setE ? `set -e; ${cmd}; echo reached-after` : cmd;
  const r = spawnSync('sh', ['-c', body], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf-8',
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : [];
  return { status: r.status, stdout: r.stdout, calls };
}

describe('aptQuietUpdate', () => {
  it('is one line with double quotes only, so it embeds in a single-quoted YAML scalar', () => {
    const cmd = aptQuietUpdate('-o X=1');
    expect(cmd).not.toContain('\n');
    expect(cmd).not.toContain("'");
    expect(APT_QUIET_CONF).toBe('/run/vibecarbon-boot.conf');
    expect(cmd).toContain(APT_LOCK_OPT);
  });

  it('loads its config with -c from /run and never touches apt.conf.d or removes anything', () => {
    const cmd = aptQuietUpdate('-o X=1');
    expect(cmd).toContain(`> ${APT_QUIET_CONF}; apt-get -c ${APT_QUIET_CONF} `);
    expect(cmd).not.toContain('apt.conf.d');
    expect(cmd).not.toMatch(/\brm\b/);
  });

  for (const setE of [false, true]) {
    const label = setE ? ' under set -e' : '';
    it(`apt succeeds${label}: exit 0, apt saw all four #clear lines through -c`, () => {
      fakeApt([0]);
      const r = run(aptQuietUpdate('-o Foo=bar', conf), setE);
      expect(r.status).toBe(0);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatch(new RegExp(`^conf -c ${conf} .*update -qq -o Foo=bar`));
      const seen = readFileSync(join(dir, 'conf.seen.1'), 'utf-8');
      for (const k of CLEARS) expect(seen).toContain(`#clear ${k};`);
      if (setE) expect(r.stdout).toContain('reached-after');
    });

    it(`apt fails${label}: exit non-zero, that status is apt's own`, () => {
      fakeApt([100]);
      const r = run(aptQuietUpdate('', conf), setE);
      expect(r.status).toBe(100);
      expect(r.calls).toHaveLength(1);
      if (setE) expect(r.stdout).not.toContain('reached-after');
    });
  }

  it('trimmed indexes switch off languages and the four desktop-metadata targets', () => {
    expect(APT_TRIMMED_INDEXES).toContain('-o Acquire::Languages=none');
    for (const t of ['CNF', 'DEP-11', 'DEP-11-icons-small', 'DEP-11-icons-hidpi']) {
      expect(APT_TRIMMED_INDEXES).toContain(
        `-o Acquire::IndexTargets::deb::${t}::DefaultEnabled=false`,
      );
    }
  });
});

describe('aptWaitForDailyUnits', () => {
  /** A systemd-run / timeout pair on PATH that log their argv. */
  function fakeUnits(opts: { systemdRunRc?: number; withSystemdRun?: boolean }) {
    if (opts.withSystemdRun !== false) {
      writeFileSync(
        join(dir, 'systemd-run'),
        `#!/bin/sh\necho "systemd-run $*" >> "${log}"\nexit ${opts.systemdRunRc ?? 0}\n`,
      );
      chmodSync(join(dir, 'systemd-run'), 0o755);
    }
    writeFileSync(
      join(dir, 'timeout'),
      `#!/bin/sh\necho "timeout $1" >> "${log}"\nshift\nexec "$@"\n`,
    );
    chmodSync(join(dir, 'timeout'), 0o755);
  }

  function runIsolated(cmd: string) {
    // PATH holds only the fakes plus the real sh, so a missing systemd-run stays missing.
    const r = spawnSync('/bin/sh', ['-c', `set -e; ${cmd}; echo reached-after`], {
      env: { PATH: dir },
      encoding: 'utf-8',
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : [];
    return { status: r.status, stdout: r.stdout, calls };
  }

  it('is one line with double quotes only, ASCII', () => {
    const cmd = aptWaitForDailyUnits();
    expect(cmd).not.toContain('\n');
    expect(cmd).not.toContain("'");
    expect([...cmd].every((ch) => ch.codePointAt(0) <= 0x7f)).toBe(true);
  });

  it('makes one blocking systemd-run call ordered after both apt units, bounded by timeout 300', () => {
    fakeUnits({});
    const r = runIsolated(aptWaitForDailyUnits());
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      'timeout 300',
      'systemd-run --quiet --wait --property=After=apt-daily.service --property=After=apt-daily-upgrade.service true',
    ]);
    expect(r.stdout).toContain('reached-after');
  });

  it('fails open when the wait itself fails, under set -e', () => {
    fakeUnits({ systemdRunRc: 1 });
    const r = runIsolated(aptWaitForDailyUnits());
    expect(r.calls).toHaveLength(2);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reached-after');
  });

  it('does nothing when systemd-run is absent', () => {
    fakeUnits({ withSystemdRun: false });
    const r = runIsolated(aptWaitForDailyUnits());
    expect(r.calls).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reached-after');
  });
});

describe('aptInstallOrRefresh', () => {
  const PKGS = 'foo=1 bar=2';

  it('install fails once then succeeds: install, update, install, exit 0', () => {
    fakeApt([100, 0, 0]);
    const r = run(aptInstallOrRefresh(PKGS), true);
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(3);
    expect(r.calls[0]).toContain(`install -y ${PKGS}`);
    expect(r.calls[1]).toMatch(/\bupdate\b/);
    expect(r.calls[2]).toContain(`install -y ${PKGS}`);
  });

  it('the fallback update is plain: hooks left in place', () => {
    fakeApt([100, 0, 0]);
    const r = run(aptInstallOrRefresh(PKGS));
    expect(r.calls[1]).toMatch(/^noconf .*update$/);
  });

  it('install succeeds: no update call', () => {
    fakeApt([0]);
    const r = run(aptInstallOrRefresh(PKGS), true);
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain('install');
  });

  it('update fails: exit non-zero, no second install', () => {
    fakeApt([100, 100, 0]);
    const r = run(aptInstallOrRefresh(PKGS));
    expect(r.status).not.toBe(0);
    expect(r.calls).toHaveLength(2);
  });
});
