/**
 * Cloud-firewall-presence check — unit pins for the RCA-driven e2e guard
 * (see tests/e2e/checks/cloud-firewall.ts's module doc for the fwtest RCA
 * this closes). Exercises found/not-found/attached/unattached/error paths
 * against a mocked provider (no real Hetzner/DigitalOcean calls), plus the
 * `.vibecarbon.json` server-name resolution that handles both the compose
 * (role-labeled `name` + separate `providerServerName`) and compose-ha
 * (already-real `name`) persisted shapes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkServerFirewall,
  extractAttachedServerIds,
  type FirewallProvider,
  resolveComposeFirewallServers,
  runCloudFirewallChecks,
} from '../../e2e/checks/cloud-firewall.js';

describe('extractAttachedServerIds', () => {
  it('reads DigitalOcean droplet_ids as strings', () => {
    expect(extractAttachedServerIds({ droplet_ids: [123, 456] })).toEqual(['123', '456']);
  });

  it('reads Hetzner applied_to[].server.id as strings', () => {
    expect(
      extractAttachedServerIds({
        applied_to: [
          { type: 'server', server: { id: 987 } },
          { type: 'server', server: { id: 654 } },
        ],
      }),
    ).toEqual(['987', '654']);
  });

  it('drops applied_to entries with no server id', () => {
    expect(
      extractAttachedServerIds({
        applied_to: [{ type: 'server', server: {} }, { type: 'label_selector' }],
      }),
    ).toEqual([]);
  });

  it('returns null when neither field is present (unrecognized/unknown shape)', () => {
    expect(extractAttachedServerIds({ id: 'fw-1', name: 'x-firewall' })).toBeNull();
  });
});

describe('checkServerFirewall', () => {
  it('passes when the firewall exists and is attached (DigitalOcean shape)', async () => {
    const provider: FirewallProvider = {
      findFirewallByName: async (name) =>
        name === 'acme-e2-primary-firewall' ? { id: 'fw-do-1', name, droplet_ids: [111] } : null,
    };
    const result = await checkServerFirewall(provider, { name: 'acme-e2-primary', id: 111 });
    expect(result.status).toBe('pass');
    expect(result.checkName).toBe('cloud_firewall_present:acme-e2-primary');
    expect(result.details).toMatchObject({
      firewallName: 'acme-e2-primary-firewall',
      firewallId: 'fw-do-1',
      serverId: '111',
      attached: true,
    });
    expect(result.details?.attachmentWarning).toBeUndefined();
  });

  it('passes when the firewall exists and is attached (Hetzner applied_to shape)', async () => {
    const provider: FirewallProvider = {
      findFirewallByName: async () => ({
        id: 42,
        applied_to: [{ type: 'server', server: { id: 999 } }],
      }),
    };
    const result = await checkServerFirewall(provider, { name: 'acme-e2', id: 999 });
    expect(result.status).toBe('pass');
    expect(result.details).toMatchObject({ attached: true });
  });

  it('fails when findFirewallByName returns null (no firewall by that name)', async () => {
    const provider: FirewallProvider = { findFirewallByName: async () => null };
    const result = await checkServerFirewall(provider, { name: 'acme-e2', id: 1 });
    expect(result.status).toBe('fail');
    expect(result.errorMessage).toContain("No cloud firewall named 'acme-e2-firewall'");
    expect(result.errorMessage).toContain("server 'acme-e2'");
  });

  it('fails (not throws) when findFirewallByName rejects', async () => {
    const provider: FirewallProvider = {
      findFirewallByName: async () => {
        throw new Error('DO API 500');
      },
    };
    const result = await checkServerFirewall(provider, { name: 'acme-e2', id: 1 });
    expect(result.status).toBe('fail');
    expect(result.errorMessage).toContain('DO API 500');
  });

  it('passes but WARNS (never fails) when the firewall exists but is not attached to this server', async () => {
    const provider: FirewallProvider = {
      findFirewallByName: async () => ({ id: 'fw-1', droplet_ids: [222] }),
    };
    const result = await checkServerFirewall(provider, { name: 'acme-e2', id: 111 });
    expect(result.status).toBe('pass');
    expect(result.details).toMatchObject({ attached: false });
    expect(result.details?.attachmentWarning).toContain('does not include server id 111');
  });

  it('leaves attachment undeterminable (null, no warning) when the shape is unrecognized', async () => {
    const provider: FirewallProvider = {
      findFirewallByName: async () => ({ id: 'fw-1', name: 'acme-e2-firewall' }),
    };
    const result = await checkServerFirewall(provider, { name: 'acme-e2', id: 111 });
    expect(result.status).toBe('pass');
    expect(result.details).toMatchObject({ attached: null });
    expect(result.details?.attachmentWarning).toBeUndefined();
  });

  it('leaves attachment undeterminable when the server id is unknown', async () => {
    const provider: FirewallProvider = {
      findFirewallByName: async () => ({ id: 'fw-1', droplet_ids: [222] }),
    };
    const result = await checkServerFirewall(provider, { name: 'acme-e2', id: null });
    expect(result.status).toBe('pass');
    expect(result.details).toMatchObject({ attached: null });
    expect(result.details?.attachmentWarning).toBeUndefined();
  });
});

describe('runCloudFirewallChecks', () => {
  it('fails loudly (no skip) when no provider instance is available', async () => {
    const results = await runCloudFirewallChecks(null, [{ name: 'acme-e2', id: 1 }]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ checkName: 'cloud_firewall_present', status: 'fail' });
    expect(results[0].errorMessage).toContain('No provider instance available');
  });

  it('fails loudly (no skip) when no deployed servers are known', async () => {
    const provider: FirewallProvider = { findFirewallByName: async () => ({}) };
    const results = await runCloudFirewallChecks(provider, []);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ checkName: 'cloud_firewall_present', status: 'fail' });
    expect(results[0].errorMessage).toContain('No deployed servers found');
  });

  it('runs one result per server, mixing pass and fail independently', async () => {
    const provider: FirewallProvider = {
      findFirewallByName: async (name) =>
        name === 'acme-e2-primary-firewall' ? { id: 'fw-1', droplet_ids: [1] } : null,
    };
    const results = await runCloudFirewallChecks(provider, [
      { name: 'acme-e2-primary', id: 1 },
      { name: 'acme-e2-standby', id: 2 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      checkName: 'cloud_firewall_present:acme-e2-primary',
      status: 'pass',
    });
    expect(results[1]).toMatchObject({
      checkName: 'cloud_firewall_present:acme-e2-standby',
      status: 'fail',
    });
  });
});

describe('resolveComposeFirewallServers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fw-resolve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (obj: unknown) =>
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(obj), 'utf-8');

  it('prefers providerServerName over the role-labeled name (compose single-server shape)', () => {
    write({
      environments: {
        e2: {
          servers: [{ name: 'master', providerServerName: 'acme-e2', id: 555, ip: '1.2.3.4' }],
        },
      },
    });
    expect(resolveComposeFirewallServers(dir, 'e2')).toEqual([{ name: 'acme-e2', id: 555 }]);
  });

  it('falls back to name when providerServerName is absent (compose-ha shape)', () => {
    write({
      environments: {
        e2: {
          servers: [
            { name: 'acme-e2-primary', id: 1, role: 'primary' },
            { name: 'acme-e2-standby', id: 2, role: 'standby' },
          ],
        },
      },
    });
    expect(resolveComposeFirewallServers(dir, 'e2')).toEqual([
      { name: 'acme-e2-primary', id: 1 },
      { name: 'acme-e2-standby', id: 2 },
    ]);
  });

  it('returns an empty array when config is missing or the env is absent', () => {
    expect(resolveComposeFirewallServers(dir, 'e2')).toEqual([]);
    write({ environments: { other: { servers: [{ name: 'x' }] } } });
    expect(resolveComposeFirewallServers(dir, 'e2')).toEqual([]);
  });

  it('skips server entries with neither name nor providerServerName', () => {
    write({ environments: { e2: { servers: [{ id: 1 }, { name: 'acme-e2', id: 2 }] } } });
    expect(resolveComposeFirewallServers(dir, 'e2')).toEqual([{ name: 'acme-e2', id: 2 }]);
  });
});
