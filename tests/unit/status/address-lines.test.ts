/**
 * `vibecarbon status`'s held-IP rows (formatAddressLines). A DigitalOcean k8s
 * cluster takes traffic at its master's own address; a reserved IP one made
 * before 2026-11 still has on record is held only until a deploy sees DNS has
 * moved off it (lib/deploy/k8s/retired-reserved-ip.js). Shown as the
 * ingress, it would send someone checking their DNS to the wrong address.
 */
import { describe, expect, it } from 'vitest';
import { formatAddressLines } from '../../../src/status.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (envConfig: object) => formatAddressLines(envConfig).map(strip);

describe('formatAddressLines', () => {
  it('DigitalOcean: a held reserved IP is labelled old and not released, never the ingress', () => {
    expect(
      lines({ provider: 'digitalocean', ingressIp: '198.51.100.7', floatingIp: '203.0.113.9' }),
    ).toEqual(['Reserved IP    203.0.113.9 (old, not released yet)']);
  });

  it('DigitalOcean k8s-ha: each side held, once each', () => {
    expect(
      lines({
        provider: 'digitalocean',
        ha: {
          primary: { ingressIp: '198.51.100.1', floatingIp: '203.0.113.10' },
          standby: { ingressIp: '198.51.100.2', floatingIp: '203.0.113.20' },
        },
      }),
    ).toEqual([
      'Reserved IP    203.0.113.10 (old, not released yet)',
      'Reserved IP    203.0.113.20 (old, not released yet)',
    ]);
  });

  it('DigitalOcean with nothing held: no row', () => {
    expect(lines({ provider: 'digitalocean', ingressIp: '198.51.100.7' })).toEqual([]);
  });

  it('Hetzner and Linode: the floating IP is the ingress, as before', () => {
    for (const provider of ['hetzner', 'linode']) {
      expect(lines({ provider, floatingIp: '203.0.113.9' }), provider).toEqual([
        'Floating IP    203.0.113.9',
      ]);
    }
    expect(lines({ provider: 'hetzner' })).toEqual([]);
  });
});
