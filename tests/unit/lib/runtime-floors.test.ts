/**
 * The runtime floors table. We do not pin tool versions, so the protection
 * against an old tool is a floor and an early, plain failure. Two things have
 * to hold: a version we cannot read never blocks anyone, and a floor set too
 * high would stop deploys that work, so the numbers here are the verified ones.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  floorFor,
  judgeVersion,
  kubectlFloorProblem,
  kubectlSkewWarning,
  parseVersion,
  RUNTIME_FLOORS,
  rowFor,
  tooOldMessage,
  unreadableMessage,
} from '../../../src/lib/runtime-floors.js';

describe('parseVersion: only what a tool really prints', () => {
  it.each([
    ['27.5.1', '27.5.1'],
    ['v1.35.0', '1.35.0'],
    ['5.6.1', '5.6.1'],
    ['2.24.5+ds1-0ubuntu1', '2.24.5'],
    ['v2.29.1-desktop.1', '2.29.1'],
    ['24.0.7-0ubuntu2~24.04.1', '24.0.7'],
    ['20.10.24+dfsg1', '20.10.24'],
    ['29.1.0-rc.1', '29.1.0'],
    ['1.31.5+k3s1', '1.31.5'],
    ['25.0', '25.0.0'],
    ['  3.259.0\n', '3.259.0'],
    ['OpenSSH_9.6p1 Ubuntu-3ubuntu13.20, OpenSSL 3.0.13 30 Jan 2024', '9.6.0'],
    ['OpenSSH_7.5p1-hpn14v4, LibreSSL 2.5.5', '7.5.0'],
    ['OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2', '9.5.0'],
  ])('%s reads as %s', (raw, want) => {
    expect(parseVersion(raw)).toBe(want);
  });

  it.each([
    [''],
    ['dev'],
    ['<no value>'],
    ['unknown'],
    ['Docker version 27.5.1, build 9f9e405'],
    ['podman-compose version 1.0.6'],
    ['Sun_SSH_1.1'],
    [null],
    [undefined],
  ])('%s is not a version', (raw) => {
    expect(parseVersion(raw as string)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('2.9.0', '2.24.4')).toBeLessThan(0);
    expect(compareVersions('2.24.4', '2.24.4')).toBe(0);
    expect(compareVersions('5.0.0', '2.24.4')).toBeGreaterThan(0);
  });
});

describe('the floors', () => {
  it('Docker Engine on a server: 25.0, set by start_interval', () => {
    const row = floorFor('docker-engine', 'server');
    expect(row?.min).toBe('25.0.0');
    expect(row?.id).toBe('engine-start-interval');
  });

  it('a server on 27.5.1 stays deployable: 86aeb04f handles both docker save shapes', () => {
    expect(judgeVersion('docker-engine', 'server', '27.5.1').verdict).toBe('ok');
    const save = rowFor('engine-save-platform');
    expect(save.min).toBe('28.0.0');
    expect(save.notFloor).toMatch(/86aeb04f/);
  });

  it('Compose: 2.24.4, on a server and on a laptop', () => {
    expect(floorFor('compose', 'server')?.min).toBe('2.24.4');
    expect(floorFor('compose', 'laptop')?.min).toBe('2.24.4');
  });

  it('no floor for Docker Engine on a laptop: nothing was proven to need one', () => {
    expect(floorFor('docker-engine', 'laptop')).toBeNull();
  });

  it('OpenSSH: 7.6, set by accept-new', () => {
    expect(floorFor('openssh', 'laptop')?.id).toBe('ssh-accept-new');
    expect(floorFor('openssh', 'laptop')?.min).toBe('7.6.0');
  });

  it('kubectl: 1.24, set by patch --subresource and not by kustomize', () => {
    expect(rowFor('kubectl-patch-subresource').min).toBe('1.24.0');
    expect(rowFor('kubectl-patch-subresource').notFloor).toBeUndefined();
    expect(rowFor('kubectl-kustomize-url').notFloor).toMatch(/kustomize v5 is not required/);
  });

  it('Node: read from package.json, with no second copy', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(pkg.engines.node).toContain(floorFor('node', 'laptop')?.min);
  });

  it('every row says what needs it and how that was established', () => {
    expect(RUNTIME_FLOORS.length).toBeGreaterThan(0);
    for (const row of RUNTIME_FLOORS) {
      expect(row.feature, row.id).toBeTruthy();
      expect(row.source, row.id).toBeTruthy();
      expect(row.where.length, row.id).toBeGreaterThan(0);
    }
    expect(new Set(RUNTIME_FLOORS.map((r) => r.id)).size).toBe(RUNTIME_FLOORS.length);
  });

  it('a version a row marks as not a floor never sets one', () => {
    for (const row of RUNTIME_FLOORS.filter((r) => r.notFloor)) {
      for (const where of row.where) expect(floorFor(row.tool, where)?.id).not.toBe(row.id);
    }
  });
});

describe('judgeVersion: refuses only what it read and knows is too old', () => {
  it('under the floor is too old', () => {
    const v = judgeVersion('compose', 'server', '2.24.3');
    expect(v).toMatchObject({ verdict: 'too-old', found: '2.24.3' });
    expect(v.floor?.min).toBe('2.24.4');
  });

  it('at the floor and far past it are fine: a floor is never a ceiling', () => {
    expect(judgeVersion('compose', 'server', '2.24.4').verdict).toBe('ok');
    expect(judgeVersion('compose', 'server', '99.0.0').verdict).toBe('ok');
  });

  it.each([[''], ['dev'], ['<no value>'], [null], [undefined]])(
    'an unreadable version (%s) is never a refusal',
    (raw) => {
      expect(judgeVersion('docker-engine', 'server', raw as string).verdict).toBe('unreadable');
    },
  );

  it('a tool with no floor here is fine whatever it says', () => {
    expect(judgeVersion('docker-engine', 'laptop', '1.0.0').verdict).toBe('ok');
  });
});

describe('the messages say what was found, what is needed and what to do', () => {
  const floor = rowFor('compose-merge-tags');

  it('tooOldMessage', () => {
    const m = tooOldMessage({
      tool: 'compose',
      found: '2.23.3',
      floor,
      subject: 'on 203.0.113.7',
      fix: 'Update it, then deploy again.',
    });
    expect(m).toContain('Docker Compose 2.23.3 on 203.0.113.7 is too old');
    expect(m).toContain('Found:');
    expect(m).toContain('Needed:');
    expect(m).toContain('2.24.4 or newer');
    expect(m).toContain('Update it, then deploy again.');
    expect(m).not.toMatch(/—/);
  });

  it('unreadableMessage quotes what came back and says the deploy continues', () => {
    const m = unreadableMessage({ tool: 'compose', raw: 'dev', subject: 'on 203.0.113.7' });
    expect(m).toContain('Docker Compose');
    expect(m).toContain('"dev"');
    expect(m).toMatch(/continu/i);
    expect(m).not.toMatch(/—/);
  });
});

describe('kubectlFloorProblem: judges `kubectl version --client -o json`', () => {
  const version = (minor: string, major = '1') =>
    JSON.stringify({ clientVersion: { major, minor, gitVersion: `v${major}.${minor}.0` } });

  it('refuses a client under the floor, saying what was found and what is needed', () => {
    const problem = kubectlFloorProblem(version('23'));
    expect(problem).toContain('kubectl 1.23 is too old');
    expect(problem).toContain('1.24.0 or newer');
    expect(problem).toContain('then run the deploy again');
  });

  it('passes the floor and anything above it', () => {
    expect(kubectlFloorProblem(version('24'))).toBeNull();
    expect(kubectlFloorProblem(version('26'))).toBeNull();
    expect(kubectlFloorProblem(version('35'))).toBeNull();
    expect(kubectlFloorProblem(version('28+'))).toBeNull();
    expect(kubectlFloorProblem(version('0', '2'))).toBeNull();
  });

  it('output it cannot read is not a refusal', () => {
    expect(kubectlFloorProblem('')).toBeNull();
    expect(kubectlFloorProblem('not json')).toBeNull();
    expect(kubectlFloorProblem('{}')).toBeNull();
  });
});

describe('kubectlSkewWarning: outside one minor warns, and never throws', () => {
  it('within one minor says nothing', () => {
    expect(kubectlSkewWarning({ client: '1.32.0', server: '1.31.5' })).toBeNull();
    expect(kubectlSkewWarning({ client: '1.31.0', server: '1.31.5' })).toBeNull();
    expect(kubectlSkewWarning({ client: '1.30.0', server: '1.31.5' })).toBeNull();
  });

  it('two minors either way warns, naming both versions', () => {
    const m = kubectlSkewWarning({ client: '1.35.0', server: '1.31.5' });
    expect(m).toContain('1.35');
    expect(m).toContain('1.31');
    expect(kubectlSkewWarning({ client: '1.29.0', server: '1.31.5' })).toContain('1.29');
  });

  it('a version it cannot read says nothing', () => {
    expect(kubectlSkewWarning({ client: '', server: '1.31.5' })).toBeNull();
    expect(kubectlSkewWarning({ client: '1.31.0', server: null })).toBeNull();
    expect(kubectlSkewWarning({})).toBeNull();
  });
});
