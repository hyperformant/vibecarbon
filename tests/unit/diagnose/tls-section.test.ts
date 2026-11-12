/**
 * `vibecarbon diagnose <env> tls`: the cert-manager evidence an operator
 * needs when a certificate is pending. When an Order fails, Let's Encrypt's
 * reason is on its Challenge and in the controller log, never on the Order
 * (src/lib/deploy/k8s/acme-challenges.js). Hetzner k8s-ha, CI run
 * 42426102569: the diagnostics held neither, so the cause stayed unknown.
 * Both reads are bounded: the log by --since and --tail, each read by
 * kubectl's request timeout.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn((..._args: unknown[]) => '');
vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import { DIAGNOSE_LOG_BOUNDS, diagnoseK8s, SPEC } from '../../../src/diagnose.js';
import { CERT_MANAGER_CONTROLLER } from '../../../src/lib/deploy/k8s/acme-challenges.js';
import { createTempDir } from '../../_shared/temp-dir.js';

function stubReport() {
  const sections: string[] = [];
  return {
    sections,
    section: (title: string) => sections.push(title),
    subsection: () => {},
    command: () => {},
    output: () => {},
    warn: () => {},
  };
}

async function run(sectionsToRun: string[]) {
  const dir = createTempDir('vc-diag-tls-');
  const kubeconfig = join(dir, 'kubeconfig');
  writeFileSync(kubeconfig, 'apiVersion: v1\n');
  const report = stubReport();
  await diagnoseK8s({
    report,
    cmdEnv: {},
    kubeconfig,
    sshKey: join(dir, 'no-such-key'),
    controlplaneIp: null,
    Provider: { K8S_ASSETS: {} },
    providerId: 'hetzner',
    sectionsToRun,
  });
  const calls = execFileSyncMock.mock.calls.map(([cmd, args]) => ({
    cmd: String(cmd),
    args: args as string[],
  }));
  return { calls, sections: report.sections, kubeconfig };
}

beforeEach(() => {
  execFileSyncMock.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('diagnose tls', () => {
  it('reads every cert-manager object, Challenges included, with their reasons', async () => {
    const { calls, kubeconfig } = await run(['tls']);
    const get = calls.find((c) => c.args.includes('get'));
    expect(get?.cmd).toBe('kubectl');
    expect(get?.args).toEqual([
      '--kubeconfig',
      kubeconfig,
      'get',
      'certificate,certificaterequest,order,challenge',
      '--all-namespaces',
      // -o wide: the Reason column of Orders and Challenges is priority 1.
      '-o',
      'wide',
      `--request-timeout=${DIAGNOSE_LOG_BOUNDS.requestTimeoutSec}s`,
    ]);
  });

  it('reads the cert-manager controller log, bounded by window, lines and timeout', async () => {
    const { calls } = await run(['tls']);
    const logs = calls.find((c) => c.args.includes('logs'));
    expect(logs?.args.slice(2)).toEqual([
      '-n',
      CERT_MANAGER_CONTROLLER.namespace,
      'logs',
      `deployment/${CERT_MANAGER_CONTROLLER.deployment}`,
      `--since=${DIAGNOSE_LOG_BOUNDS.sinceMinutes}m`,
      `--tail=${DIAGNOSE_LOG_BOUNDS.tailLines}`,
      `--request-timeout=${DIAGNOSE_LOG_BOUNDS.requestTimeoutSec}s`,
    ]);
    expect(DIAGNOSE_LOG_BOUNDS.requestTimeoutSec).toBeLessThan(60);
  });

  it('runs in the default sweep and on its own, and nowhere else', async () => {
    const all = await run(['nodes', 'pods', 'tls', 'network', 'flux', 'hcloud']);
    expect(all.sections).toContain('TLS (cert-manager)');
    execFileSyncMock.mockClear();
    const flux = await run(['flux']);
    expect(flux.sections).not.toContain('TLS (cert-manager)');
    expect(flux.calls.some((c) => c.args.includes('challenge'))).toBe(false);
  });

  it('is a section the command accepts and its help names', () => {
    const section = SPEC.positional?.find((p) => p.name === 'section');
    expect(section?.description).toMatch(/\btls\b/);
  });
});
