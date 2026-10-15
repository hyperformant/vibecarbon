import { describe, expect, it } from 'vitest';
import { completionSummaryLines, entryIpFor } from '../../../src/lib/deploy/completion-summary.js';

// Without a domain the deploy used to end on "complete!" with the server IP
// long scrolled away. The closing note must always say where the site lives.
describe('entryIpFor', () => {
  it('uses the lone VPS for compose', () => {
    expect(entryIpFor({ masterIp: '1.1.1.1' })).toBe('1.1.1.1');
  });
  it('uses the primary for compose-HA', () => {
    expect(entryIpFor({ primaryIp: '2.2.2.2', standbyIp: '3.3.3.3' })).toBe('2.2.2.2');
  });
  it('prefers the floating IP for k8s', () => {
    expect(entryIpFor({ masterIp: '1.1.1.1', floatingIp: '9.9.9.9' })).toBe('9.9.9.9');
  });
  it('prefers the primary floating IP for k8s-HA', () => {
    expect(
      entryIpFor({ primary: { masterIp: '1.1.1.1', floatingIp: '9.9.9.9' }, standby: {} }),
    ).toBe('9.9.9.9');
  });
  it('returns null when nothing is known', () => {
    expect(entryIpFor({})).toBeNull();
  });
});

describe('completionSummaryLines', () => {
  const servers = [{ name: 'master', ip: '178.156.217.45' }];

  it('links the bare IP over http when no domain is set (manual DNS fallback)', () => {
    const lines = completionSummaryLines({
      environment: 'prod',
      domain: null,
      dnsProvider: 'manual',
      entryIp: '178.156.217.45',
      servers,
    });
    expect(lines[0]).toBe('Open:     http://178.156.217.45');
    expect(lines.join('\n')).toContain('no domain yet');
    expect(lines.join('\n')).not.toContain('A record');
  });

  it('asks for an A record when the domain uses manual DNS', () => {
    const text = completionSummaryLines({
      environment: 'prod',
      domain: 'app.example.com',
      dnsProvider: 'manual',
      entryIp: '178.156.217.45',
      servers,
    }).join('\n');
    expect(text).toContain('Open:     https://app.example.com');
    expect(text).toContain('A record   app.example.com  →  178.156.217.45');
  });

  it('skips the A-record step when a DNS provider manages the zone', () => {
    const text = completionSummaryLines({
      environment: 'prod',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      entryIp: '178.156.217.45',
      servers,
    }).join('\n');
    expect(text).toContain('https://app.example.com');
    expect(text).not.toContain('A record');
  });

  it('lists every server for HA tiers', () => {
    const text = completionSummaryLines({
      environment: 'prod',
      domain: 'app.example.com',
      dnsProvider: 'hetzner',
      entryIp: '2.2.2.2',
      servers: [
        { name: 'primary', ip: '2.2.2.2' },
        { name: 'standby', ip: '3.3.3.3' },
      ],
    }).join('\n');
    expect(text).toContain('primary   2.2.2.2');
    expect(text).toContain('standby   3.3.3.3');
  });

  it('always ends with next-step commands for the environment', () => {
    const lines = completionSummaryLines({
      environment: 'staging',
      domain: null,
      dnsProvider: 'manual',
      entryIp: '1.1.1.1',
      servers,
    });
    expect(lines.at(-2)).toMatch(/^vibecarbon status staging/);
    expect(lines.at(-1)).toMatch(/^vibecarbon diagnose staging/);
  });
});
