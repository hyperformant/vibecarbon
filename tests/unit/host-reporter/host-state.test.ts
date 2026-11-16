import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOST_STATE_ANNOTATION,
  hostStateFromNode,
  mainPackage,
  PACKAGE_PATTERN,
  parseHostState,
  REBOOT_TRIGGER_PATTERNS,
} from '../../../src/lib/host-state.js';

const read = (name: string) =>
  readFileSync(join(__dirname, '../../../carbon/tests/fixtures/host-state', name), 'utf-8');

describe('parseHostState', () => {
  it('reads a due state', () => {
    expect(parseHostState(read('due.json'))).toEqual({
      host: 'web-1',
      rebootRequired: true,
      since: '2026-11-15T06:42:10Z',
      packages: ['linux-base', 'linux-image-6.8.0-90-generic'],
    });
  });
  it('reads a clear state', () => {
    expect(parseHostState(read('clear.json'))).toEqual({
      host: 'web-1',
      rebootRequired: false,
      since: null,
      packages: [],
    });
  });
  it('caps packages at 20', () => {
    expect(parseHostState(read('many-packages.json'))?.packages.length).toBe(20);
  });
  it('drops hostile package names and keeps the valid ones', () => {
    expect(parseHostState(read('hostile.json'))).toEqual({
      host: 'web-1',
      rebootRequired: true,
      since: '2026-11-15T06:42:10Z',
      packages: ['curl', 'linux-image-6.8.0-90-generic', 'libc6:amd64'],
    });
  });
  const state = (over: object) =>
    JSON.stringify({
      v: 1,
      host: 'web-1',
      rebootRequired: false,
      since: null,
      packages: [],
      ...over,
    });
  it('rejects text over 16384 characters', () => {
    expect(parseHostState(state({ host: 'a'.repeat(20000) }))).toBeNull();
    expect(parseHostState(`${state({})}${' '.repeat(16384)}`)).toBeNull();
  });
  it.each(['', '-web', 'we b', 'web<1>', 'a'.repeat(254), '\u001b[31m'])(
    'rejects host %j',
    (host) => {
      expect(parseHostState(state({ host }))).toBeNull();
    },
  );
  it.each([
    'yesterday',
    '2026-13-45T99:99:99Z',
    '2026-11-15 06:42:10',
    '2026-11-15T06:42:10+00:00',
    '<b>',
  ])('rejects since %j', (since) => {
    expect(parseHostState(state({ since }))).toBeNull();
  });
  it('drops a package name over 128 characters', () => {
    expect(parseHostState(state({ packages: ['a'.repeat(200), 'curl'] }))?.packages).toEqual([
      'curl',
    ]);
  });
  it('keeps the package cap after dropping bad names', () => {
    const packages = ['a b', ...Array.from({ length: 25 }, (_, i) => `pkg-${i}`)];
    expect(parseHostState(state({ packages }))?.packages).toHaveLength(20);
  });
  it.each([read('malformed.txt'), '{"v":2}', ''])('returns null for %j', (text) => {
    expect(parseHostState(text)).toBeNull();
  });
});

describe('hostStateFromNode', () => {
  it('reads the annotation', () => {
    const node = {
      metadata: { name: 'w1', annotations: { [HOST_STATE_ANNOTATION]: read('due.json') } },
    };
    expect(hostStateFromNode(node)).toMatchObject({
      name: 'w1',
      reporting: true,
      state: { rebootRequired: true },
    });
  });
  it('reports a node without the annotation as not reporting', () => {
    expect(hostStateFromNode({ metadata: { name: 'w2' } })).toEqual({
      name: 'w2',
      reporting: false,
      state: null,
    });
  });
});

describe('mainPackage', () => {
  it('prefers a kernel package', () => {
    expect(mainPackage(['libc6', 'linux-image-6.8.0-90-generic'])).toBe(
      'linux-image-6.8.0-90-generic',
    );
  });
  it('falls back to the first, or null', () => {
    expect(mainPackage(['curl', 'openssl'])).toBe('curl');
    expect(mainPackage([])).toBeNull();
  });
});

describe('REBOOT_TRIGGER_PATTERNS', () => {
  const hit = (n: string) => REBOOT_TRIGGER_PATTERNS.some((re) => re.test(n));
  it.each([
    'linux-image-6.8.0-90-generic',
    'linux-firmware',
    'libc6',
    'systemd',
    'dbus',
    'libpam0g',
  ])('matches %s', (n) => {
    expect(hit(n)).toBe(true);
  });
  it.each(['curl', 'openssl'])('does not match %s', (n) => {
    expect(hit(n)).toBe(false);
  });
  it.each(['linux-modules-extra-6.8.0-90-generic', 'linux-image-generic', 'linux-base'])(
    'matches the whole kernel package name %s',
    (n) => {
      expect(hit(n)).toBe(true);
    },
  );
  // The kernel pattern is anchored at both ends: a name that only starts like
  // one, or carries anything but package-name characters, is no trigger.
  it.each(['linux-imagex', 'linux-image-6.8\u001b[2J', 'linux-firmware ', 'linux-base\nx'])(
    'does not match %j',
    (n) => {
      expect(hit(n)).toBe(false);
    },
  );
});

describe('PACKAGE_PATTERN', () => {
  it('is the one package-name rule, shared with the update inspector', () => {
    expect(PACKAGE_PATTERN.test('libc6:amd64')).toBe(true);
    expect(PACKAGE_PATTERN.test('linux-image-6.8.0-90-generic')).toBe(true);
    expect(PACKAGE_PATTERN.test('curl\u001b[2J')).toBe(false);
    expect(PACKAGE_PATTERN.test('Docker')).toBe(false);
  });
});
