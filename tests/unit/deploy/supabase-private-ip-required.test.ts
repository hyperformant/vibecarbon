/**
 * supabasePrivateIp is REQUIRED in provider-generic k8s-ha code — no
 * `10.0.1.2` fallback anywhere outside Hetzner-owned files.
 *
 * Class (d4 audit, 2026-08-27): "statically-pinned Hetzner private-IP default
 * leaking into provider-generic code". Hetzner's IaC program pins the
 * supabase node to 10.0.1.2 (hetzner-k8s.js ServerNetwork), and that literal
 * had metastasized into defaults/fallbacks in the shared HA transport,
 * re-seed, and helm-values paths. On DigitalOcean the VPC is 10.10.0.0/20
 * with DHCP-assigned addresses, so every fallback site is a silent breakage:
 * socat binds a nonexistent address (repl-gateway CrashLoop), the egress
 * NetworkPolicy scopes to a nonexistent /32, and the failover re-seed's
 * pg_isready probe "fails closed" into 'skipped' — promotion without re-seed,
 * a data-loss-shaped soft failure.
 *
 * The contract: the value is a real IaC output on every provider
 * (hetzner-k8s.js exports the static; digitalocean-k8s.js exports the real
 * Pulumi-assigned address) and must be THREADED, never assumed. Absent value
 * = incomplete infra step result = throw.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  prepareReplicationTransport,
  reestablishReplicationTransport,
  setupReplication,
} from '../../../src/lib/deploy/k8s/ha/index.js';
import { installSupabase } from '../../../src/lib/deploy/k8s/k3s.js';
import { reseedStandbyFromPrimary } from '../../../src/lib/deploy/replication.js';

const ROOT = join(__dirname, '../../..');

const baseTransportArgs = {
  primaryIp: '203.0.113.10',
  standbyIp: '203.0.113.20',
  primarySupabaseIp: '203.0.113.11',
  standbySupabaseIp: '203.0.113.21',
  sshKeyPath: '/tmp/nonexistent-test-key',
};

describe('supabasePrivateIp is required (no 10.0.1.2 fallback)', () => {
  it('prepareReplicationTransport throws when primarySupabasePrivateIp is absent', async () => {
    await expect(
      prepareReplicationTransport({
        ...baseTransportArgs,
        standbySupabasePrivateIp: '10.10.0.5',
      }),
    ).rejects.toThrow(/primarySupabasePrivateIp.*required/i);
  });

  it('prepareReplicationTransport throws when standbySupabasePrivateIp is absent', async () => {
    await expect(
      prepareReplicationTransport({
        ...baseTransportArgs,
        primarySupabasePrivateIp: '10.10.0.4',
      }),
    ).rejects.toThrow(/standbySupabasePrivateIp.*required/i);
  });

  it('reestablishReplicationTransport throws when the private IPs are absent', async () => {
    await expect(reestablishReplicationTransport({ ...baseTransportArgs })).rejects.toThrow(
      /SupabasePrivateIp.*required/i,
    );
  });

  it('setupReplication throws when the private IPs are absent (before any password read)', async () => {
    await expect(setupReplication({ ...baseTransportArgs })).rejects.toThrow(
      /SupabasePrivateIp.*required/i,
    );
  });

  it('reseedStandbyFromPrimary throws when standbySupabasePrivateIp is absent', async () => {
    await expect(
      reseedStandbyFromPrimary('203.0.113.20', '/tmp/nonexistent-test-key', {
        standbySupabaseIp: '203.0.113.21',
      }),
    ).rejects.toThrow(/standbySupabasePrivateIp.*required/i);
  });

  it('installSupabase throws when supabasePrivateIp is absent (before any shell-out)', async () => {
    await expect(
      installSupabase({
        kubeconfig: '/tmp/nonexistent-kubeconfig',
        projectDir: '/tmp/nonexistent-project',
        projectName: 'testapp',
        domain: 'example.test',
        s3Config: {},
        envLocal: {},
        dbImageTag: 'x',
        backupBucketName: 'b',
        storageClass: 'hcloud-volumes',
      }),
    ).rejects.toThrow(/supabasePrivateIp.*required/i);
  });
});

/**
 * Enumerable invariant (family census): the class stays dead.
 *
 * Rather than trusting future diligence, walk the provider-generic sources
 * and fail on any resurrected literal. Comments are stripped first — prose
 * ABOUT the Hetzner static is fine; a code literal is not.
 */
const GENERIC_FILES = [
  'src/lib/deploy/k8s/ha/index.js',
  'src/lib/deploy/replication.js',
  'src/lib/deploy/k8s/standby-config.js',
  'src/lib/deploy/effects/k8s-ha.js',
  'src/lib/deploy/effects/k8s.js',
  'src/failover.js',
  'src/restore.js',
  'src/scale.js',
];

function codeWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('10.0.1.2 census — provider-generic files carry no supabase-IP literal', () => {
  for (const rel of GENERIC_FILES) {
    it(`${rel} has no quoted 10.0.1.2 literal in code`, () => {
      const code = codeWithoutComments(readFileSync(join(ROOT, rel), 'utf8'));
      expect(code).not.toMatch(/['"`]10\.0\.1\.2['"`]/);
    });
  }

  it('k3s.js has no quoted 10.0.1.2 literal in code', () => {
    const code = codeWithoutComments(readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf8'));
    expect(code).not.toMatch(/['"`]10\.0\.1\.2['"`]/);
  });

  it('k3s.js masterPrivateIp renderer defaults stay at their audited count (3)', () => {
    // The three DELIBERATE test-convenience defaults (renderCarbonAutoscalerConfig,
    // buildAppImage, pushImageViaTunnel — "renderer default stays for tests",
    // M3 Task 2). The live deployK3s path destructures the k3s-infra step
    // result WITHOUT a default and validates instead. A 4th occurrence means
    // the class is growing again — remove the new default, don't bump this.
    const code = codeWithoutComments(readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf8'));
    const occurrences = code.match(/masterPrivateIp\s*=\s*'10\.0\.1\.1'/g) ?? [];
    expect(occurrences).toHaveLength(3);
  });

  it("positive control: hetzner-k8s.js still pins the statics ('10.0.1.1'/'10.0.1.2')", () => {
    const src = readFileSync(join(ROOT, 'src/lib/iac/programs/hetzner-k8s.js'), 'utf8');
    expect(src).toMatch(/'10\.0\.1\.1'/);
    expect(src).toMatch(/'10\.0\.1\.2'/);
  });
});
