import { describe, expect, it } from 'vitest';
import {
  addCidr,
  applyToFirewall,
  loadOperatorCidrs,
  parseAllowedSshIpsEnv,
  pruneCidrs,
  refreshLastUsed,
  removeCidr,
} from '../../../src/lib/operator-ip.js';

describe('loadOperatorCidrs', () => {
  it('returns empty array when projectConfig has no operatorCidrs field', () => {
    expect(loadOperatorCidrs({})).toEqual([]);
  });

  it('returns empty array when projectConfig is null', () => {
    expect(loadOperatorCidrs(null)).toEqual([]);
  });

  it('returns the persisted list', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-04-28T00:00:00Z', lastUsedAt: '2026-04-28T00:00:00Z' },
    ];
    expect(loadOperatorCidrs({ operatorCidrs: list })).toEqual(list);
  });
});

describe('addCidr', () => {
  const fixedNow = new Date('2026-04-28T18:00:00Z');

  it('appends a new entry with addedAt and lastUsedAt set', () => {
    const result = addCidr([], '1.2.3.4/32', fixedNow);
    expect(result).toEqual([
      {
        cidr: '1.2.3.4/32',
        addedAt: '2026-04-28T18:00:00.000Z',
        lastUsedAt: '2026-04-28T18:00:00.000Z',
      },
    ]);
  });

  it('refreshes lastUsedAt without duplicating an existing entry', () => {
    const original = [
      {
        cidr: '1.2.3.4/32',
        addedAt: '2026-04-01T00:00:00.000Z',
        lastUsedAt: '2026-04-01T00:00:00.000Z',
      },
    ];
    const result = addCidr(original, '1.2.3.4/32', fixedNow);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      cidr: '1.2.3.4/32',
      addedAt: '2026-04-01T00:00:00.000Z',
      lastUsedAt: '2026-04-28T18:00:00.000Z',
    });
  });

  it('does not mutate the input list', () => {
    const original: { cidr: string; addedAt: string; lastUsedAt: string }[] = [];
    addCidr(original, '1.2.3.4/32', fixedNow);
    expect(original).toEqual([]);
  });

  it('preserves order when appending', () => {
    let list: { cidr: string; addedAt: string; lastUsedAt: string }[] = [];
    list = addCidr(list, '1.2.3.4/32', fixedNow);
    list = addCidr(list, '5.6.7.8/32', fixedNow);
    list = addCidr(list, '9.10.11.12/32', fixedNow);
    expect(list.map((e) => e.cidr)).toEqual(['1.2.3.4/32', '5.6.7.8/32', '9.10.11.12/32']);
  });
});

describe('removeCidr', () => {
  it('removes a matching entry', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-04-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z' },
      { cidr: '5.6.7.8/32', addedAt: '2026-04-02T00:00:00Z', lastUsedAt: '2026-04-02T00:00:00Z' },
    ];
    const result = removeCidr(list, '1.2.3.4/32');
    expect(result).toHaveLength(1);
    expect(result[0].cidr).toBe('5.6.7.8/32');
  });

  it('returns the list unchanged when CIDR is absent', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-04-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z' },
    ];
    expect(removeCidr(list, '99.99.99.99/32')).toEqual(list);
  });

  it('does not mutate the input list', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-04-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z' },
    ];
    removeCidr(list, '1.2.3.4/32');
    expect(list).toHaveLength(1);
  });
});

describe('pruneCidrs', () => {
  const now = new Date('2026-04-28T00:00:00Z');

  it('keeps entries used within the maxAge window', () => {
    const list = [
      // 30 days ago — kept
      { cidr: '1.2.3.4/32', addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-03-29T00:00:00Z' },
      // 95 days ago — dropped
      { cidr: '5.6.7.8/32', addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-23T00:00:00Z' },
    ];
    const result = pruneCidrs(list, now, 90);
    expect(result.map((e) => e.cidr)).toEqual(['1.2.3.4/32']);
  });

  it('uses 90 days as the default cutoff', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-04-15T00:00:00Z' },
      { cidr: '5.6.7.8/32', addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-15T00:00:00Z' },
    ];
    const result = pruneCidrs(list, now);
    expect(result.map((e) => e.cidr)).toEqual(['1.2.3.4/32']);
  });

  it('drops entries with malformed lastUsedAt', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-01-01T00:00:00Z', lastUsedAt: 'not-a-date' },
    ];
    expect(pruneCidrs(list, now)).toEqual([]);
  });

  it('returns empty when input is empty', () => {
    expect(pruneCidrs([], now)).toEqual([]);
  });
});

describe('refreshLastUsed', () => {
  const fixedNow = new Date('2026-04-28T18:00:00Z');

  it('updates lastUsedAt for the matching entry only', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-04-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z' },
      { cidr: '5.6.7.8/32', addedAt: '2026-04-02T00:00:00Z', lastUsedAt: '2026-04-02T00:00:00Z' },
    ];
    const result = refreshLastUsed(list, '1.2.3.4/32', fixedNow);
    expect(result[0].lastUsedAt).toBe('2026-04-28T18:00:00.000Z');
    expect(result[0].addedAt).toBe('2026-04-01T00:00:00Z');
    expect(result[1].lastUsedAt).toBe('2026-04-02T00:00:00Z');
  });

  it('returns the list unchanged when CIDR is absent', () => {
    const list = [
      { cidr: '1.2.3.4/32', addedAt: '2026-04-01T00:00:00Z', lastUsedAt: '2026-04-01T00:00:00Z' },
    ];
    const result = refreshLastUsed(list, '99.99.99.99/32', fixedNow);
    expect(result).toEqual(list);
  });
});

describe('applyToFirewall — missing-token error names the environment provider', () => {
  const operatorCidrs = [
    { cidr: '1.2.3.4/32', addedAt: '2026-04-28T00:00:00Z', lastUsedAt: '2026-04-28T00:00:00Z' },
  ];

  it('names Hetzner and HETZNER_API_TOKEN for a Hetzner (default) environment', async () => {
    await expect(
      applyToFirewall({
        projectName: 'proj',
        environments: ['prod'],
        operatorCidrs,
        apiToken: undefined,
        envConfig: { provider: 'hetzner' },
      }),
    ).rejects.toThrow(
      'Hetzner Cloud API token required to update firewall (set HETZNER_API_TOKEN).',
    );
  });

  it('names DigitalOcean and DIGITALOCEAN_API_TOKEN for a DigitalOcean environment, not Hetzner', async () => {
    await expect(
      applyToFirewall({
        projectName: 'proj',
        environments: ['prod'],
        operatorCidrs,
        apiToken: undefined,
        envConfig: { provider: 'digitalocean' },
      }),
    ).rejects.toThrow(
      'DigitalOcean API token required to update firewall (set DIGITALOCEAN_API_TOKEN).',
    );
  });

  it('does not mention Hetzner anywhere in the DigitalOcean error message', async () => {
    try {
      await applyToFirewall({
        projectName: 'proj',
        environments: ['prod'],
        operatorCidrs,
        apiToken: undefined,
        envConfig: { provider: 'digitalocean' },
      });
      throw new Error('expected applyToFirewall to throw');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/Hetzner/);
    }
  });
});

describe('parseAllowedSshIpsEnv', () => {
  it('returns empty array for undefined / empty input', () => {
    expect(parseAllowedSshIpsEnv(undefined)).toEqual([]);
    expect(parseAllowedSshIpsEnv('')).toEqual([]);
  });

  it('splits comma-separated CIDRs', () => {
    expect(parseAllowedSshIpsEnv('1.2.3.4/32,5.6.7.8/32')).toEqual(['1.2.3.4/32', '5.6.7.8/32']);
  });

  it('trims whitespace around each entry', () => {
    expect(parseAllowedSshIpsEnv(' 1.2.3.4/32 , 5.6.7.8/32 ')).toEqual([
      '1.2.3.4/32',
      '5.6.7.8/32',
    ]);
  });

  it('drops empty entries from trailing commas', () => {
    expect(parseAllowedSshIpsEnv('1.2.3.4/32,,')).toEqual(['1.2.3.4/32']);
  });
});
