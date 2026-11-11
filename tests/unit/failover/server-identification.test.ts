import { describe, expect, it } from 'vitest';
import { identifyServers } from '../../../src/failover.js';

describe('identifyServers', () => {
  it('identifies servers from ha.primary/standby config', () => {
    const envConfig = {
      ha: {
        enabled: true,
        primary: { masterIp: '1.2.3.4', floatingIp: '10.0.0.1', region: 'fsn1' },
        standby: { masterIp: '5.6.7.8', floatingIp: '10.0.0.2', region: 'nbg1' },
      },
    };

    const result = identifyServers('prod', envConfig, { environments: {} });
    expect(result).toEqual({
      primary: { ip: '1.2.3.4', floatingIp: '10.0.0.1', region: 'fsn1', envKey: 'prod' },
      standby: { ip: '5.6.7.8', floatingIp: '10.0.0.2', region: 'nbg1', envKey: 'prod' },
    });
  });

  it('falls back to masterIp when floatingIp is not in config', () => {
    const envConfig = {
      ha: {
        enabled: true,
        primary: { masterIp: '1.2.3.4', region: 'fsn1' },
        standby: { masterIp: '5.6.7.8', region: 'nbg1' },
      },
    };

    const result = identifyServers('prod', envConfig, { environments: {} });
    expect(result).toEqual({
      primary: { ip: '1.2.3.4', floatingIp: '1.2.3.4', region: 'fsn1', envKey: 'prod' },
      standby: { ip: '5.6.7.8', floatingIp: '5.6.7.8', region: 'nbg1', envKey: 'prod' },
    });
  });

  it('flips DNS to the recorded ingressIp, over a retired reserved IP still on record', () => {
    // A DigitalOcean env whose deploy moved its records to the masters but
    // could not release the old reserved IP: the flip target is the master.
    const envConfig = {
      ha: {
        enabled: true,
        primary: {
          masterIp: '1.2.3.4',
          ingressIp: '1.2.3.4',
          floatingIp: '10.0.0.1',
          region: 'nyc3',
        },
        standby: { masterIp: '5.6.7.8', ingressIp: '5.6.7.8', region: 'sfo3' },
      },
    };

    const result = identifyServers('prod', envConfig, { environments: {} });
    expect(result?.primary.floatingIp).toBe('1.2.3.4');
    expect(result?.standby.floatingIp).toBe('5.6.7.8');
  });

  it('a DigitalOcean standby not yet deployed on this version flips DNS to its reserved IP', () => {
    // No deploy has recorded an ingressIp, so the domain still points at the
    // reserved IPs. Failover's converge takes the standby's reserved IP out
    // of the stack's state rather than delete it (lib/iac/retired-resources.js),
    // so it is still assigned to the standby's master and serving: the flip
    // target is that address, never the master's own, which no record or
    // cache has ever named.
    const envConfig = {
      ha: {
        enabled: true,
        primary: { masterIp: '1.2.3.4', floatingIp: '203.0.113.9', region: 'nyc3' },
        standby: { masterIp: '5.6.7.8', floatingIp: '203.0.113.10', region: 'sfo3' },
      },
    };

    const result = identifyServers('prod', envConfig, { environments: {} });
    expect(result?.standby.floatingIp).toBe('203.0.113.10');
    expect(result?.primary.floatingIp).toBe('203.0.113.9');
  });

  it('identifies servers from the servers array by role', () => {
    const envConfig = {
      servers: [
        { ip: '1.2.3.4', name: 'app-fsn1', role: 'primary' },
        { ip: '5.6.7.8', name: 'app-nbg1', role: 'standby' },
      ],
      region: 'fsn1',
      secondaryRegion: 'nbg1',
    };

    const result = identifyServers('prod', envConfig, { environments: {} });
    expect(result).toEqual({
      primary: { ip: '1.2.3.4', region: 'fsn1', envKey: 'prod' },
      standby: { ip: '5.6.7.8', region: 'nbg1', envKey: 'prod' },
    });
  });

  it('refuses a roleless servers array instead of guessing from order or names', () => {
    const envConfig = {
      servers: [
        { ip: '1.2.3.4', name: 'server-a' },
        { ip: '5.6.7.8', name: 'server-b' },
      ],
      region: 'fsn1',
      secondaryRegion: 'nbg1',
    };
    expect(() => identifyServers('prod', envConfig, { environments: {} })).toThrow(
      /exactly one server with role 'primary'/,
    );
  });

  it('uses ha.failoverRegion as secondary region', () => {
    const envConfig = {
      servers: [
        { ip: '1.2.3.4', name: 'a', role: 'primary' },
        { ip: '5.6.7.8', name: 'b', role: 'standby' },
      ],
      region: 'fsn1',
      ha: { failoverRegion: 'hel1' },
    };

    const result = identifyServers('prod', envConfig, { environments: {} });
    expect(result).not.toBeNull();
    expect(result?.standby.region).toBe('hel1');
  });

  it('returns null when no HA config and insufficient servers', () => {
    expect(identifyServers('prod', {}, { environments: {} })).toBeNull();
    expect(
      identifyServers('prod', { servers: [{ ip: '1.2.3.4' }] }, { environments: {} }),
    ).toBeNull();
  });

  it('returns null when servers exist but no regions defined', () => {
    const envConfig = {
      servers: [
        { ip: '1.2.3.4', name: 'a', role: 'primary' },
        { ip: '5.6.7.8', name: 'b', role: 'standby' },
      ],
    };
    expect(identifyServers('prod', envConfig, { environments: {} })).toBeNull();
  });

  it('prefers ha.primary/standby over servers array', () => {
    const envConfig = {
      ha: {
        enabled: true,
        primary: { masterIp: '10.0.0.1', floatingIp: '10.0.1.1', region: 'fsn1' },
        standby: { masterIp: '10.0.0.2', floatingIp: '10.0.1.2', region: 'nbg1' },
      },
      servers: [
        { ip: '1.2.3.4', name: 'wrong' },
        { ip: '5.6.7.8', name: 'wrong' },
      ],
      region: 'fsn1',
      secondaryRegion: 'nbg1',
    };

    const result = identifyServers('prod', envConfig, { environments: {} });
    expect(result?.primary.ip).toBe('10.0.0.1');
    expect(result?.primary.floatingIp).toBe('10.0.1.1');
    expect(result?.standby.ip).toBe('10.0.0.2');
    expect(result?.standby.floatingIp).toBe('10.0.1.2');
  });
});
