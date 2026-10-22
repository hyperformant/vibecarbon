/**
 * cert-manager controller flags, set by one test-and-set (one read, at most
 * one patch) before the readiness wait so the rollout carries them:
 *
 * - The DNS-01 self-check uses PUBLIC RECURSIVE resolvers, not the zone's
 *   authoritative servers (d4 run 3 RCA, 2026-08-28): both Hetzner and
 *   DigitalOcean DNS are anycast, and the POP a region egresses to can serve
 *   a freshly-written record MINUTES late. Let's Encrypt validates from its
 *   own vantage, so our gate should match a public recursive view.
 * - The minimum backoff after a failed CertificateRequest is 5 minutes
 *   instead of cert-manager's 1 hour, so a first issuance that misses the
 *   deploy's first look is retried soon after (the deploy finishes with TLS
 *   pending instead of waiting out the CA).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CERT_MANAGER_CONTROLLER_FLAGS,
  ensureCertManagerControllerFlags,
} from '../../../src/lib/deploy/k8s/k3s.js';

const SRC = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf8');

const ALL = [
  '--dns01-recursive-nameservers=1.1.1.1:53,8.8.8.8:53',
  '--dns01-recursive-nameservers-only',
  '--certificate-request-minimum-backoff-duration=5m',
];

function deployment(args: string[]) {
  return JSON.stringify({
    spec: {
      template: {
        spec: { containers: [{ name: 'cert-manager-controller', args: ['--v=2', ...args] }] },
      },
    },
  });
}

function fakeKubectl(getOut: string) {
  const calls: Array<{ argv: string[]; opts: Record<string, unknown> }> = [];
  const kubectl = vi.fn(async (argv: string[], opts: Record<string, unknown> = {}) => {
    calls.push({ argv, opts });
    return argv.includes('get') ? getOut : '';
  });
  return { kubectl, calls };
}

const patches = (calls: Array<{ argv: string[] }>) => calls.filter((c) => c.argv.includes('patch'));

describe('cert-manager controller flags', () => {
  it('is the recursive self-check pair plus the 5 minute minimum backoff', () => {
    expect([...CERT_MANAGER_CONTROLLER_FLAGS]).toEqual(ALL);
  });

  it('with no flag present, one json patch adds all three', async () => {
    const { kubectl, calls } = fakeKubectl(deployment([]));
    await ensureCertManagerControllerFlags({ env: {}, kubectl });
    expect(calls.filter((c) => c.argv.includes('get'))).toHaveLength(1);
    const ps = patches(calls);
    expect(ps).toHaveLength(1);
    expect(ps[0].argv).toContain('--type=json');
    const ops = JSON.parse(ps[0].argv[ps[0].argv.indexOf('-p') + 1]);
    expect(ops).toEqual(
      ALL.map((value) => ({ op: 'add', path: '/spec/template/spec/containers/0/args/-', value })),
    );
  });

  it('with every flag present, no patch runs (warm redeploys never duplicate)', async () => {
    const { kubectl, calls } = fakeKubectl(deployment(ALL));
    await ensureCertManagerControllerFlags({ env: {}, kubectl });
    expect(patches(calls)).toHaveLength(0);
  });

  it('with the older two present, the patch adds only the backoff', async () => {
    const { kubectl, calls } = fakeKubectl(deployment(ALL.slice(0, 2)));
    await ensureCertManagerControllerFlags({ env: {}, kubectl });
    const ps = patches(calls);
    expect(ps).toHaveLength(1);
    expect(JSON.parse(ps[0].argv[ps[0].argv.indexOf('-p') + 1])).toEqual([
      {
        op: 'add',
        path: '/spec/template/spec/containers/0/args/-',
        value: '--certificate-request-minimum-backoff-duration=5m',
      },
    ]);
  });

  it('unreadable deployment JSON skips the patch instead of failing the deploy', async () => {
    const { kubectl, calls } = fakeKubectl('not json');
    await ensureCertManagerControllerFlags({ env: {}, kubectl });
    expect(patches(calls)).toHaveLength(0);
  });

  it('runs BEFORE the cert-manager readiness wait (the rollout must carry the flags)', () => {
    const callIdx = SRC.indexOf('ensureCertManagerControllerFlags({ env })');
    const waitIdx = SRC.indexOf('2. Wait for cert-manager to be ready');
    expect(callIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(callIdx);
  });
});
