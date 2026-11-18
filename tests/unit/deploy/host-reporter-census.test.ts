/**
 * Every server gets the host reporter (carbon/cloud-init/k3s/_host-reporter.sh)
 * without a new SSH step.
 *
 * New k8s workers (and the autoscaler's) get it from their cloud-init, after
 * the k3s install so the kubelet kubeconfig exists. The master's user data does
 * not carry it (its size is near the provider cap); the master, db node and
 * every older server get it from the SSH sessions every deploy already opens:
 * the k8s per-node pre-pull and the compose backup-cron step.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderCarbonAutoscalerConfig } from '../../../src/lib/deploy/k8s/k3s.js';
import { HOST_REPORTER_SNIPPET } from '../../../src/lib/host-reporter.js';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { bootScriptFiles, k8sBootScripts } from '../../_shared/k3s-boot-scripts.js';

const runCommandAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runCommandAsync,
}));

const { prePullImages } = await import('../../../src/lib/deploy/k8s/k3s.js');
const { setupComposeBackupCron } = await import('../../../src/lib/deploy/compose/index.js');
const { readFileSync } = await import('node:fs');

const MARK = 'vibecarbon-host-reporter.path';
const INSTALLER = readFileSync(HOST_REPORTER_SNIPPET, 'utf-8');
const workers = bootScriptFiles().filter((f) => f.endsWith('worker-init.sh'));

describe('host reporter: k8s workers install it after the k3s install', () => {
  it('walks every worker script (never vacuously green)', () => {
    expect(workers.length).toBeGreaterThanOrEqual(3);
  });

  it.each(workers)('%s includes the snippet after get.k3s.io', (name) => {
    const raw = readFileSync(`${process.cwd()}/carbon/cloud-init/k3s/${name}`, 'utf-8');
    const include = raw.indexOf('# @include _host-reporter.sh');
    expect(include, `${name}: no include`).toBeGreaterThan(-1);
    expect(include).toBeGreaterThan(raw.indexOf('get.k3s.io'));
    expect(loadCloudInit(name)).toContain(MARK);
  });

  it.each([
    ['hetzner', HetznerProvider, 'nbg1', 'cx23'],
    ['digitalocean', DigitalOceanProvider, 'nyc3', 's-2vcpu-4gb'],
    ['linode', LinodeProvider, 'us-ord', 'g6-standard-2'],
  ])(
    '%s: autoscaler-created workers boot with it',
    async (providerId, ProviderClass, region, type) => {
      const cfg = JSON.parse(
        await renderCarbonAutoscalerConfig({
          k3sVersion: 'v1.37.2+k3s1',
          k3sToken: 'deadbeefcafe1234567890abcdef',
          clusterName: 'acme-prod',
          environment: 'prod',
          providerId,
          ProviderClass,
          region,
          workerServerType: type,
          minWorkers: 1,
          maxWorkers: 4,
        }),
      );
      expect(cfg.nodeGroups['worker-pool'].cloudInit).toContain(MARK);
    },
  );
});

describe('host reporter: the SSH sessions every deploy opens carry the installer', () => {
  it('prePullImages installs it on every node', async () => {
    runCommandAsync.mockReset().mockResolvedValue({ stdout: '' });
    await prePullImages({
      nodeIps: ['203.0.113.1', '203.0.113.2'],
      sshKeyPath: '/k',
      khPath: '/kh',
    });
    expect(runCommandAsync).toHaveBeenCalledTimes(2);
    for (const [, opts] of runCommandAsync.mock.calls) {
      expect(opts.input).toContain(INSTALLER);
      expect(opts.input).toContain('k3s ctr -n k8s.io images pull');
    }
  });

  it('setupComposeBackupCron installs it on the server', async () => {
    const runScript = vi.fn().mockResolvedValue(undefined);
    await setupComposeBackupCron('203.0.113.1', '/k', 'proj', {}, { runScript });
    expect(runScript).toHaveBeenCalledTimes(1);
    const script = runScript.mock.calls[0][2] as string;
    expect(script).toContain(INSTALLER);
    expect(script).toContain('crontab "$TMP_CRON"');
  });
});

describe('host reporter: the db node takes it over SSH, not from its user data', () => {
  // Deliberate (6095af55): the deploy installs it on the db node and the
  // master in prePullImages, every run. Only autoscaler-spawned workers, which
  // no deploy session reaches, need it at boot.
  it.each([
    ['hetzner', HetznerProvider],
    ['digitalocean', DigitalOceanProvider],
    ['linode', LinodeProvider],
  ])('%s: the db node boots without it, from the worker script', async (_id, P) => {
    expect(await P.getK8sWorkerUserData({})).toContain(MARK);
    expect(await P.getK8sDbUserData({})).not.toContain(MARK);
  });
});

describe('host reporter: Hetzner renders stay under the user-data cap', () => {
  it('worker and db stay under 28 KiB; the master does not carry the snippet', async () => {
    const hetzner = (await k8sBootScripts()).filter((s) => s.provider === 'hetzner');
    expect(hetzner.length).toBe(3);
    for (const { role, userData: text } of hetzner) {
      if (role === 'master') {
        expect(text).not.toContain(MARK);
      } else {
        expect(Buffer.byteLength(text), `${role} render size`).toBeLessThan(28 * 1024);
      }
    }
  });
});
