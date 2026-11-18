/**
 * `diagnose` on a k8s tier runs its host probes (k3s status and journal,
 * containerd, addresses, routes, links, resolv.conf) over raw ssh. They used
 * to pass only `StrictHostKeyChecking=accept-new`, so ssh read and wrote the
 * operator's own ~/.ssh/known_hosts: a provider that recycled the IP left a
 * stale personal entry that failed the probe, and every probe added one. The
 * rest of the CLI, the compose branch of this command included, pins against
 * the environment's own file (`.vibecarbon/known_hosts_<env>`, derived from
 * the deploy key by buildHostKeyOpts). The k8s probes use the same options.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn((..._args: unknown[]) => '');
vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import { diagnoseK8s } from '../../../src/diagnose.js';
import { buildHostKeyOpts } from '../../../src/lib/host-keys.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { sshArgv } from '../../../src/lib/ssh.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const IP = '203.0.113.7';

function stubReport() {
  return {
    section: () => {},
    subsection: () => {},
    command: () => {},
    output: () => {},
    warn: () => {},
  };
}

async function sshCalls() {
  const dir = createTempDir('vc-diag-hostkey-');
  mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  const kubeconfig = join(dir, 'kubeconfig');
  writeFileSync(kubeconfig, 'apiVersion: v1\n');
  const sshKey = join(dir, '.vibecarbon', 'deploy_key_prod');
  writeFileSync(sshKey, 'not a real key\n');
  await diagnoseK8s({
    report: stubReport(),
    cmdEnv: {},
    kubeconfig,
    sshKey,
    controlplaneIp: IP,
    Provider: PROVIDERS.hetzner,
    providerId: 'hetzner',
    sectionsToRun: ['nodes', 'egress'],
  });
  const calls = execFileSyncMock.mock.calls
    .filter(([cmd]) => cmd === 'ssh')
    .map(([, args]) => args as string[]);
  return { calls, sshKey, dir };
}

beforeEach(() => {
  execFileSyncMock.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('diagnose k8s host probes pin host keys per environment', () => {
  it('every ssh probe passes the per-environment known_hosts options, then the host', async () => {
    const { calls, sshKey } = await sshCalls();
    // nodes: k3s status, k3s journal, containerd, addresses, dmesg;
    // egress: routes, addresses, links, resolv.conf.
    expect(calls).toHaveLength(9);
    const opts = buildHostKeyOpts(sshKey);
    for (const args of calls) {
      expect(args.slice(0, 2 + opts.length), args.join(' ')).toEqual(['-i', sshKey, ...opts]);
      expect(args[2 + opts.length]).toBe(`root@${IP}`);
      expect(args).toHaveLength(opts.length + 4);
    }
  });

  it('never reads or writes the operator ~/.ssh/known_hosts', async () => {
    const { calls, dir } = await sshCalls();
    for (const args of calls) {
      expect(args).toContain(`UserKnownHostsFile=${join(dir, '.vibecarbon', 'known_hosts_prod')}`);
      expect(args).toContain('GlobalKnownHostsFile=/dev/null');
      expect(args.filter((a) => a.startsWith('StrictHostKeyChecking='))).toEqual([
        'StrictHostKeyChecking=accept-new',
      ]);
    }
  });

  it('uses the options the compose branch gets from sshRun for the same key', async () => {
    const { calls, sshKey } = await sshCalls();
    const opts = buildHostKeyOpts(sshKey);
    // sshArgv is what sshRun spawns for diagnoseCompose (no env: derived from the key).
    expect(sshArgv(IP, sshKey, ['true']).slice(1, 3 + opts.length)).toEqual([
      '-i',
      sshKey,
      ...opts,
    ]);
    expect(calls[0].slice(0, 2 + opts.length)).toEqual(['-i', sshKey, ...opts]);
  });
});
