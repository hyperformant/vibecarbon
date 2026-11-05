/**
 * The boot refresh: narrow to what we install, hooks silenced for that one
 * refresh only, conf file gone afterwards in every case (including apt failing).
 * The returned shell really runs under `sh -c` with a fake `apt-get` first on
 * PATH, plain and under `set -e`.
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
    expect(APT_QUIET_CONF).toBe('/etc/apt/apt.conf.d/99zz-vibecarbon-boot');
    expect(cmd).toContain(APT_LOCK_OPT);
  });

  for (const setE of [false, true]) {
    const label = setE ? ' under set -e' : '';
    it(`apt succeeds${label}: exit 0, conf gone, apt saw all four #clear lines`, () => {
      fakeApt([0]);
      const r = run(aptQuietUpdate('-o Foo=bar', conf), setE);
      expect(r.status).toBe(0);
      expect(existsSync(conf)).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toMatch(/^conf .*update -qq -o Foo=bar/);
      const seen = readFileSync(join(dir, 'conf.seen.1'), 'utf-8');
      for (const k of CLEARS) expect(seen).toContain(`#clear ${k};`);
      if (setE) expect(r.stdout).toContain('reached-after');
    });

    it(`apt fails${label}: exit non-zero, conf gone`, () => {
      fakeApt([100]);
      const r = run(aptQuietUpdate('', conf), setE);
      expect(r.status).not.toBe(0);
      expect(existsSync(conf)).toBe(false);
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
