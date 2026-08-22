import { describe, expect, it } from 'vitest';
import {
  cidrsOverlap,
  deriveComposeProjectName,
  findSubnetConflict,
  parseNetworkInspect,
  pickFreeSubnetPrefix,
} from '../../../src/lib/subnet.js';

// Regression guard for `vibecarbon up` in a SECOND project on the same Docker
// daemon: every generated project pins vibecarbon-network to the same
// 172.30.0.0/24, so the second project's network creation failed with
// "invalid pool request: Pool overlaps with other one on this address space".
// `up` now detects the overlap (like port conflicts) and picks a free /24.

describe('cidrsOverlap', () => {
  it('identical /24s overlap', () => {
    expect(cidrsOverlap('172.30.0.0/24', '172.30.0.0/24')).toBe(true);
  });

  it('adjacent /24s do not overlap', () => {
    expect(cidrsOverlap('172.30.0.0/24', '172.30.1.0/24')).toBe(false);
  });

  it('a /16 contains its /24s', () => {
    expect(cidrsOverlap('172.30.0.0/16', '172.30.7.0/24')).toBe(true);
    expect(cidrsOverlap('172.30.7.0/24', '172.30.0.0/16')).toBe(true);
  });

  it('distinct private ranges do not overlap', () => {
    expect(cidrsOverlap('172.17.0.0/16', '172.30.0.0/24')).toBe(false);
    expect(cidrsOverlap('10.0.0.0/8', '172.30.0.0/24')).toBe(false);
  });
});

describe('parseNetworkInspect', () => {
  const inspectJson = JSON.stringify([
    {
      Name: 'my-app_vibecarbon-network',
      Labels: { 'com.docker.compose.project': 'my-app' },
      IPAM: { Config: [{ Subnet: '172.30.0.0/24' }] },
    },
    {
      Name: 'bridge',
      Labels: null,
      IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] },
    },
    {
      Name: 'host',
      Labels: {},
      IPAM: { Config: null },
    },
    {
      Name: 'v6-net',
      Labels: {},
      IPAM: { Config: [{ Subnet: 'fd00::/64' }, { Subnet: '172.19.0.0/16' }] },
    },
  ]);

  it('extracts name, compose project label, and IPv4 subnets', () => {
    const networks = parseNetworkInspect(inspectJson);
    expect(networks).toEqual([
      { name: 'my-app_vibecarbon-network', project: 'my-app', subnets: ['172.30.0.0/24'] },
      { name: 'bridge', project: null, subnets: ['172.17.0.0/16'] },
      { name: 'host', project: null, subnets: [] },
      { name: 'v6-net', project: null, subnets: ['172.19.0.0/16'] },
    ]);
  });
});

describe('deriveComposeProjectName', () => {
  it('lowercases the directory name', () => {
    expect(deriveComposeProjectName('Swim')).toBe('swim');
  });

  it('strips characters compose disallows', () => {
    expect(deriveComposeProjectName('my.app')).toBe('myapp');
  });

  it('strips leading separators (compose project names start alphanumeric)', () => {
    expect(deriveComposeProjectName('_hidden-app')).toBe('hidden-app');
  });
});

const OTHER_PROJECT_NET = {
  name: 'my-app_vibecarbon-network',
  project: 'my-app',
  subnets: ['172.30.0.0/24'],
};
const OWN_NET = {
  name: 'swim_vibecarbon-network',
  project: 'swim',
  subnets: ['172.30.0.0/24'],
};
const BRIDGE = { name: 'bridge', project: null, subnets: ['172.17.0.0/16'] };

describe('findSubnetConflict', () => {
  it('flags another project holding the default subnet', () => {
    const conflict = findSubnetConflict('172.30.0', [OTHER_PROJECT_NET, BRIDGE], 'swim');
    expect(conflict).toEqual(OTHER_PROJECT_NET);
  });

  it("ignores this project's own network (compose reuses it, never recreates)", () => {
    expect(findSubnetConflict('172.30.0', [OWN_NET, BRIDGE], 'swim')).toBeNull();
  });

  it('returns null when nothing overlaps', () => {
    expect(findSubnetConflict('172.30.1', [OTHER_PROJECT_NET, BRIDGE], 'swim')).toBeNull();
  });
});

describe('pickFreeSubnetPrefix', () => {
  it('prefers the lowest free /24 in 172.30.0.0/16', () => {
    expect(pickFreeSubnetPrefix([OTHER_PROJECT_NET], 'swim')).toBe('172.30.1');
  });

  it('skips every taken /24', () => {
    const taken = [
      OTHER_PROJECT_NET,
      { name: 'x', project: null, subnets: ['172.30.1.0/24'] },
      { name: 'y', project: null, subnets: ['172.30.2.0/24'] },
    ];
    expect(pickFreeSubnetPrefix(taken, 'swim')).toBe('172.30.3');
  });

  it("does not count this project's own network as taken", () => {
    expect(pickFreeSubnetPrefix([OWN_NET], 'swim')).toBe('172.30.0');
  });

  it('returns null when the whole /16 is covered', () => {
    const blanket = [{ name: 'vpn', project: null, subnets: ['172.30.0.0/16'] }];
    expect(pickFreeSubnetPrefix(blanket, 'swim')).toBeNull();
  });
});
