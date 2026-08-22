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

  it('identifies servers from servers array with region matching', () => {
    const envConfig = {
      servers: [
        { ip: '1.2.3.4', name: 'app-fsn1' },
        { ip: '5.6.7.8', name: 'app-nbg1' },
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

  it('falls back to array order when names do not match regions', () => {
    const envConfig = {
      servers: [
        { ip: '1.2.3.4', name: 'server-a' },
        { ip: '5.6.7.8', name: 'server-b' },
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

  it('uses ha.failoverRegion as secondary region', () => {
    const envConfig = {
      servers: [
        { ip: '1.2.3.4', name: 'a' },
        { ip: '5.6.7.8', name: 'b' },
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
        { ip: '1.2.3.4', name: 'a' },
        { ip: '5.6.7.8', name: 'b' },
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
