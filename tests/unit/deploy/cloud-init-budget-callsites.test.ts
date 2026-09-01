/**
 * Call-site census for the provider-owned wait budgets (cloud-init readiness
 * and waitForServer's create→ready wait).
 *
 * setupServer (src/lib/deploy/compose/index.js) defaults its timeoutMs to the
 * Hetzner-calibrated 180s. That default exists for byte-compat, but every real
 * call site MUST pass the provider-owned budget
 * (Provider.CLOUD_INIT_READY_TIMEOUT_MS): providers that install docker-ce
 * inside cloud-init (DigitalOcean) override it to 600s, and a call site that
 * omits the argument silently reverts them to 180s.
 *
 * RCA 2026-09-01 (PG17 cert run, d2 compose-ha): haSetupServers called
 * setupServer(ip, sshKeyPath) with no budget — the DO standby's cloud-init
 * finished at 313s, inside DO's intended 600s, and the deploy aborted at the
 * 180s default anyway. The single-server path (effects/index.js) and
 * scale.js already passed the budget; compose-ha was the unswept sibling of
 * the original d1 RCA that added DO's override. This census enumerates every
 * consumer so the next call site is drafted into the audited set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('every setupServer call site passes the provider-owned cloud-init budget', () => {
  it('compose-ha passes timeoutMs for BOTH servers, resolved from the env provider', () => {
    const src = read('src/lib/deploy/effects/compose-ha.js');
    expect(src).toMatch(/providerFor\(envConfig\)\.CLOUD_INIT_READY_TIMEOUT_MS/);
    expect(src).toMatch(/setupServer\(primary\.ip,\s*sshKeyPath,\s*timeoutMs\)/);
    expect(src).toMatch(/setupServer\(standby\.ip,\s*sshKeyPath,\s*timeoutMs\)/);
  });

  it('the single-server effects path resolves the budget from the env provider', () => {
    const src = read('src/lib/deploy/effects/index.js');
    expect(src).toMatch(/Provider\.CLOUD_INIT_READY_TIMEOUT_MS/);
    expect(src).toMatch(/setupServerRemote\(serverIp,\s*sshKeyPath,\s*timeoutMs\)/);
  });

  it('scale passes the budget when provisioning replacement servers', () => {
    const src = read('src/scale.js');
    expect(src).toMatch(
      /setupServer\(newIp,\s*sshKeyPath,\s*Provider\.CLOUD_INIT_READY_TIMEOUT_MS\)/,
    );
  });

  it('no NEW bare setupServer(ip, key) call sneaks into src/ (census walk)', () => {
    // Walks the deploy surfaces that import the compose setupServer. A call
    // with exactly two arguments is the bug this file exists to block. The
    // regex keys on the ip-ish first arg to avoid matching effects/index.js's
    // unrelated local `setupServer(ctx)`.
    const surfaces = [
      'src/lib/deploy/effects/compose-ha.js',
      'src/lib/deploy/effects/index.js',
      'src/scale.js',
    ];
    for (const rel of surfaces) {
      const bare = [
        ...read(rel).matchAll(/setupServer(?:Remote)?\(\s*[\w.]+(?:Ip|\.ip),\s*\w*[Kk]ey\w*\s*\)/g),
      ];
      expect(bare.map((m) => `${rel}: ${m[0]}`)).toEqual([]);
    }
  });
});

describe('waitForServer budgets are provider-owned (sibling family of the cloud-init budget)', () => {
  // RCA 2026-09-01 (d2 compose-ha scale, PG17 cert run): scale's
  // provider.waitForServer(newServerId) relied on the shared 300s default; a
  // routine DO droplet was still not active at that ceiling, the scale
  // aborted, and the droplet went active moments later as an orphan. Vultr
  // had already hit — and fixed — the identical class (OS readiness ~295s,
  // run 31663154544). The invariant: every provider's waitForServer defaults
  // its timeout to a WAIT_FOR_SERVER_TIMEOUT_MS static, so slow-boot
  // providers own a wider budget instead of shaving the shared one.
  const PROVIDERS = [
    'src/lib/providers/hetzner.js',
    'src/lib/providers/digitalocean.js',
    'src/lib/providers/linode.js',
    'src/lib/providers/scaleway.js',
    'src/lib/providers/vultr.js',
  ];

  it.each(PROVIDERS)('%s defaults waitForServer to the class static, never a literal', (rel) => {
    const src = read(rel);
    expect(src).toMatch(
      /async waitForServer\(serverId,\s*timeout = (this\.constructor|\w+Provider)\.WAIT_FOR_SERVER_TIMEOUT_MS\)/,
    );
    expect(src).not.toMatch(/async waitForServer\(serverId,\s*timeout = \d/);
  });

  it('base declares the 300s default; the two RCA-proven slow-boot providers override to 600s', async () => {
    const { BaseProvider } = await import('../../../src/lib/providers/base.js');
    const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
    const { VultrProvider } = await import('../../../src/lib/providers/vultr.js');
    expect(BaseProvider.WAIT_FOR_SERVER_TIMEOUT_MS).toBe(300_000);
    expect(DigitalOceanProvider.WAIT_FOR_SERVER_TIMEOUT_MS).toBe(600_000);
    expect(VultrProvider.WAIT_FOR_SERVER_TIMEOUT_MS).toBe(600_000);
  });
});
