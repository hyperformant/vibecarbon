/**
 * The CLI's server-side apply takes over the cloud Secrets a master's boot
 * script made, on a real apiserver.
 *
 * deployK3s hands the provider API token to the cluster on every deploy
 * (applyCloudSecrets), while the master boot scripts still create the same
 * Secrets with `kubectl create secret generic ... | kubectl apply -f -`, a
 * client-side apply. Whether a server-side apply owned by vibecarbon-cli takes
 * those over without a conflict, and what it leaves in them, is the
 * apiserver's and kubectl's business, so this asks a real one: the k3s
 * release the CLI installs, control plane only, and the kubectl on this
 * machine, the one a deploy runs.
 *
 * For every provider with a k8s tier: the boot script's own Secret commands
 * (read out of it, tests/_shared/master-init-secrets.ts) run on the node, then
 * applyCloudSecrets runs from here. It must take the Secrets over with their
 * data as it set it, replace a rotated token, and leave an unchanged Secret
 * alone, resourceVersion included, since it runs on every deploy.
 *
 * Needs Docker and kubectl. Every container here is named vctest-* and
 * removed in afterAll.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCloudSecrets } from '../../../src/lib/deploy/k8s/k3s.js';
import { renderScript } from '../../../src/lib/iac/cloud-init.js';
import { k3sVersion } from '../../../src/lib/images.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { masterInitSecrets } from '../../_shared/master-init-secrets.js';

const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const IMAGE = `rancher/k3s:${k3sVersion().replace('+', '-')}`;
const NODE = `vctest-k3s-secrets-${process.pid}`;
const LONG = 180_000;

/** What the boot script renders: a real token is shell-safe, so this one is. */
const BOOT_TOKEN = 'vc-sentinel-token-boot-1d2c';
/** A rotated token, YAML-hostile, so the stdin manifest's quoting is proven too. */
const ROTATED_TOKEN = `vc-sentinel-token-rotated: "dq" 'sq' #hash \\bs {x}`;
const NETWORK = '4210337';

const K8S_PROVIDERS = Object.entries(PROVIDERS).filter(([, P]) =>
  P.SUPPORTED_TIERS.includes('k8s'),
);

const run = (cmd: string, args: string[], input?: string) =>
  spawnSync(cmd, args, { encoding: 'utf-8', input, timeout: LONG });
const must = (cmd: string, args: string[], input?: string) => {
  const r = run(cmd, args, input);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
  }
  return r.stdout;
};
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The boot script's value for a template variable, by the naming the scripts use. */
const bootValue = (variable: string) =>
  variable === 'network_id' ? NETWORK : variable.endsWith('_token') ? BOOT_TOKEN : undefined;

describeDocker(`the CLI takes over the boot script's cloud Secrets (k3s ${k3sVersion()})`, () => {
  let dir: string;
  let kubeconfig: string;

  /** A Secret as the apiserver holds it: data decoded, its managers, its version. */
  const read = (namespace: string, name: string) => {
    const r = spawnSync(
      'kubectl',
      ['-n', namespace, 'get', 'secret', name, '-o', 'json', '--show-managed-fields'],
      { encoding: 'utf-8', env: { ...process.env, KUBECONFIG: kubeconfig } },
    );
    if (r.status !== 0) throw new Error(`get secret ${namespace}/${name}: ${r.stderr.trim()}`);
    const secret = JSON.parse(r.stdout);
    return {
      data: Object.fromEntries(
        Object.entries(secret.data as Record<string, string>).map(([k, v]) => [
          k,
          Buffer.from(v, 'base64').toString('utf8'),
        ]),
      ),
      managers: (secret.metadata.managedFields as { manager: string; operation: string }[]).map(
        ({ manager, operation }) => `${manager}:${operation}`,
      ),
      resourceVersion: secret.metadata.resourceVersion as string,
    };
  };

  beforeAll(() => {
    expect(run('kubectl', ['version', '--client']).status, 'kubectl on PATH').toBe(0);
    dir = mkdtempSync(join(tmpdir(), 'vctest-k3s-secrets-'));
    must('docker', [
      'run',
      '-d',
      '--privileged',
      '--name',
      NODE,
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/var/run',
      '-p',
      '127.0.0.1::6443',
      IMAGE,
      'server',
      // The apiserver is the subject; no node, no system pods, nothing pulled.
      '--disable-agent',
      '--disable',
      'coredns,servicelb,traefik,local-storage,metrics-server,gateway-api-crd',
      '--tls-san',
      '127.0.0.1',
    ]);
    const deadline = Date.now() + 120_000;
    while (run('docker', ['exec', NODE, 'kubectl', 'get', '--raw', '/readyz']).stdout !== 'ok') {
      if (Date.now() > deadline) throw new Error('timed out waiting for the k3s apiserver');
      sleepSync(1000);
    }
    const port = must('docker', ['port', NODE, '6443']).trim().split(':').pop();
    kubeconfig = join(dir, 'kubeconfig');
    writeFileSync(
      kubeconfig,
      must('docker', ['exec', NODE, 'cat', '/etc/rancher/k3s/k3s.yaml']).replace(
        'https://127.0.0.1:6443',
        `https://127.0.0.1:${port}`,
      ),
      { mode: 0o600 },
    );
  }, LONG);

  afterAll(() => {
    run('docker', ['rm', '-f', '-v', NODE]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // applyCloudSecrets says what it hands over, and kubectl what it applied.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(K8S_PROVIDERS)('%s', (_id, Provider) => {
    const hand = (token: string) =>
      applyCloudSecrets({
        env: { ...process.env, KUBECONFIG: kubeconfig },
        ProviderClass: Provider,
        token,
        networkId: NETWORK,
      });
    const expected = (token: string) => Provider.k8sCloudSecrets({ token, networkId: NETWORK });

    it(
      'takes over what the boot script made, with no conflict and its data as it set it',
      async () => {
        const created = masterInitSecrets(await Provider.getK8sMasterUserData({}));
        for (const { namespace, name, keys, command } of created) {
          const vars = Object.fromEntries(Object.values(keys).map((v) => [v, bootValue(v)]));
          must('docker', ['exec', '-i', NODE, 'sh', '-eu'], renderScript(command, vars));
          expect(read(namespace, name).managers).toEqual(['kubectl-client-side-apply:Update']);
        }
        await hand(BOOT_TOKEN);
        for (const { namespace, name, stringData } of expected(BOOT_TOKEN)) {
          const secret = read(namespace, name);
          expect(secret.data).toEqual(stringData);
          expect(secret.managers).toContain('vibecarbon-cli:Apply');
        }
      },
      LONG,
    );

    it(
      'leaves an unchanged Secret alone, resourceVersion included',
      async () => {
        const before = expected(BOOT_TOKEN).map(({ namespace, name }) => read(namespace, name));
        await hand(BOOT_TOKEN);
        const after = expected(BOOT_TOKEN).map(({ namespace, name }) => read(namespace, name));
        expect(after.map((s) => s.resourceVersion)).toEqual(before.map((s) => s.resourceVersion));
      },
      LONG,
    );

    it(
      'replaces a rotated token, with no conflict',
      async () => {
        await hand(ROTATED_TOKEN);
        for (const { namespace, name, stringData } of expected(ROTATED_TOKEN)) {
          expect(read(namespace, name).data).toEqual(stringData);
        }
      },
      LONG,
    );

    it(
      'wins over another server-side owner of the same keys (--force-conflicts)',
      async () => {
        // Someone else's server-side apply, say an operator's own tooling,
        // took the keys over with another value. Without --force-conflicts
        // the deploy's apply would stop on the conflict.
        const other = expected('vc-sentinel-token-other').map(({ namespace, name, stringData }) =>
          [
            'apiVersion: v1',
            'kind: Secret',
            `metadata: {name: ${name}, namespace: ${namespace}}`,
            `stringData: ${JSON.stringify(stringData)}`,
          ].join('\n'),
        );
        const r = spawnSync(
          'kubectl',
          [
            'apply',
            '--server-side',
            '--force-conflicts',
            '--field-manager=vctest-other',
            '-f',
            '-',
          ],
          {
            encoding: 'utf-8',
            input: other.join('\n---\n'),
            env: { ...process.env, KUBECONFIG: kubeconfig },
          },
        );
        expect(r.status, r.stderr).toBe(0);
        await hand(BOOT_TOKEN);
        for (const { namespace, name, stringData } of expected(BOOT_TOKEN)) {
          expect(read(namespace, name).data).toEqual(stringData);
        }
      },
      LONG,
    );
  });
});
