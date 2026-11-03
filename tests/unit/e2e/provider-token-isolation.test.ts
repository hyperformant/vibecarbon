/**
 * One provider's token never reaches another provider's API.
 *
 * Regression: runLifecycle took a `hetznerToken` for every scenario, so on a
 * DigitalOcean k8s-ha failover dns_flip_verified handed the Hetzner token to
 * the DO DNS API (401 "Unable to authenticate you"). The lifecycle now takes
 * the scenario's own provider-neutral `computeToken`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readARecord, getDnsProvider } = vi.hoisted(() => {
  const readARecord = vi.fn(async (_token: string, _zone: string, _name: string) => [
    '203.0.113.9',
  ]);
  return { readARecord, getDnsProvider: vi.fn(async (_id: string) => ({ readARecord })) };
});

vi.mock('../../../src/lib/dns-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/dns-provider.js')>();
  return { ...actual, getDnsProvider };
});

import { verifyDnsFlip } from '../../e2e/checks/ha-integrity.js';
import { hcloudChildEnv } from '../../e2e/utils/compute-token.js';

const HETZNER_SENTINEL = 'sentinel-hetzner-token';
const DO_SENTINEL = 'sentinel-do-token';

describe('verifyDnsFlip token routing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dnsflip-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        environments: {
          e4: {
            dns: { provider: 'digitalocean', zoneId: 'zone-1' },
            servers: [{ role: 'primary', ip: '203.0.113.9' }],
          },
        },
      }),
    );
    readARecord.mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a DigitalOcean scenario reads the DNS zone with the DO token, never the Hetzner one', async () => {
    const result = await verifyDnsFlip({
      projectDir: dir,
      envPrefix: 'e4',
      domain: 'a.do.example.dev',
      provider: 'digitalocean',
      computeToken: DO_SENTINEL,
    });
    expect(result.status).toBe('pass');
    expect(readARecord).toHaveBeenCalled();
    for (const call of readARecord.mock.calls) {
      expect(call[0]).toBe(DO_SENTINEL);
      expect(call[0]).not.toBe(HETZNER_SENTINEL);
    }
  });
});

describe('hcloudChildEnv', () => {
  it('sets HCLOUD_TOKEN for Hetzner only', () => {
    expect(hcloudChildEnv('hetzner', HETZNER_SENTINEL)).toEqual({ HCLOUD_TOKEN: HETZNER_SENTINEL });
    for (const p of ['digitalocean', 'linode', 'vultr', 'scaleway']) {
      expect(hcloudChildEnv(p, DO_SENTINEL)).toEqual({});
    }
  });
});

describe('census: no Hetzner-named token on provider-neutral paths', () => {
  const root = join(__dirname, '../../e2e');
  const lifecycle = readFileSync(join(root, 'scenarios/_run-lifecycle.ts'), 'utf-8');
  const runner = readFileSync(join(root, 'runner.ts'), 'utf-8');
  const collector = readFileSync(join(root, 'metrics/collector.ts'), 'utf-8');

  it('runLifecycle and the collector take a computeToken, not a hetznerToken', () => {
    expect(lifecycle).toMatch(/collector: MetricsCollector,\s+computeToken: string,/);
    expect(collector).not.toMatch(/hetznerToken/);
  });

  it('hetznerToken in the lifecycle appears only inside the Hetzner-only sweep', () => {
    const start = lifecycle.indexOf('export async function sweepOrphanedHetznerResources');
    const end = lifecycle.indexOf('export async function runLifecycle');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const outside = lifecycle.slice(0, start) + lifecycle.slice(end);
    expect(outside).not.toMatch(/hetznerToken/);
  });

  it('the runner never passes hetznerToken into runLifecycle', () => {
    const call = runner.slice(
      runner.indexOf('runLifecycle('),
      runner.indexOf('runLifecycle(') + 200,
    );
    expect(call).toContain('computeToken');
    expect(call).not.toContain('hetznerToken');
  });

  it('no deploy child env is built from a Hetzner-named token', () => {
    expect(lifecycle).not.toMatch(/HCLOUD_TOKEN:\s*hetznerToken/);
  });
});
