/**
 * The CLI hands the provider API token to the cluster after boot.
 *
 * A k8s cluster's cloud controller and CSI driver read the provider API token
 * from kube-system Secrets. The master's boot script used to be their only
 * source, which put the token in the master's user data, and Pulumi keeps user
 * data in its state in plaintext. deployK3s now applies the same Secrets
 * itself (applyCloudSecrets), on every deploy, once the apiserver serves, so
 * the boot script can stop carrying the token.
 *
 * What this file proves:
 *   - census: each k8s provider's k8sCloudSecrets names the namespaces,
 *     Secrets and keys its master boot script creates, read from the script;
 *     the token goes where a `*_token` variable went, the network id where
 *     `network_id` went; a provider without a k8s tier hands over nothing;
 *   - applyCloudSecrets: one `kubectl apply --server-side --force-conflicts
 *     --field-manager=vibecarbon-cli -f -`, with every Secret on stdin; the
 *     token never on argv, never in a log line or the error; a missing value
 *     refuses before kubectl runs, saying what to do next;
 *   - restarts: each Secret is read before the apply, its values kept as
 *     keyed digests and never printed; a Secret that existed and changed
 *     restarts exactly the workloads that read it (found from their pod
 *     templates, secretReaders), an unchanged or a new one restarts nothing;
 *   - the boot script's last-applied annotation: a Secret the read found it
 *     on has it removed after the apply, a deploy that finds none makes no
 *     call, and a failed removal warns with the command and goes on;
 *   - deployK3s: the call has its own perf span, runs after the control-plane
 *     gate and the restore-marker read, before the k3s-apply skip gate, in a
 *     block no condition guards, so a first deploy, a warm redeploy, `deploy
 *     -restore` and the k8s-ha standby all run it. Source-level, as the other
 *     deployK3s ordering guards (k3s-deploy-markers.test.ts): deployK3s needs
 *     Pulumi, ssh and a cluster to run. Biome's formatter is part of `pnpm
 *     lint`, so indentation is nesting here.
 *
 * That a server-side apply takes over Secrets the boot script made with a
 * client-side `kubectl apply`, without a conflict and with their data as it
 * set it, needs a real apiserver:
 * tests/integration/docker/k8s-cloud-secrets-takeover.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { masterInitSecrets } from '../../_shared/master-init-secrets.js';

type Call = { argv: string[]; input?: string; env?: NodeJS.ProcessEnv };
const calls: Call[] = [];
/** A kubectl call whose argv (after `kubectl`) this matches fails with kubectlFails. */
let failWhen: RegExp | null = null;
let kubectlFails: Error | null = null;

/** The Secrets the fake apiserver holds, `namespace/name` to decoded data. */
const cluster = new Map<string, Record<string, string>>();
/** The pod templates `get deployments,statefulsets,daemonsets -o json` lists, per namespace. */
let workloads: Record<string, unknown[]> = {};
/** What `get secret -o json` prints instead of the Secret, when set. */
let secretOutput: string | null = null;
/**
 * The Secrets that carry kubectl's last-applied annotation, `namespace/name`
 * to the values it records, as the boot script's client-side apply leaves
 * them. The server-side apply leaves it alone, as kubectl 1.24 and 1.25 do.
 */
const lastApplied = new Map<string, Record<string, string>>();

/** A Secret as `kubectl get -o json` prints it, with its last-applied annotation if it has one. */
function secretJson(namespace: string, name: string, data: Record<string, string>) {
  const encoded = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
  );
  const recorded = lastApplied.get(`${namespace}/${name}`);
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      resourceVersion: '4242',
      ...(recorded && {
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
            stringData: recorded,
          }),
        },
      }),
    },
    data: encoded,
    type: 'Opaque',
  });
}

/** kubectl against `cluster`: reads, the server-side apply, the workload list, restarts. */
function fakeKubectl(args: string[], input?: string): string {
  if (failWhen?.test(args.join(' ')) && kubectlFails) throw kubectlFails;
  if (args[0] === '-n' && args[2] === 'get' && args[3] === 'secret') {
    const data = cluster.get(`${args[1]}/${args[4]}`);
    if (secretOutput !== null) return secretOutput;
    return data ? secretJson(args[1], args[4], data) : '';
  }
  if (args[0] === 'apply') {
    for (const doc of loadAll(String(input)) as {
      metadata: { namespace: string; name: string };
      stringData: Record<string, string>;
    }[]) {
      const key = `${doc.metadata.namespace}/${doc.metadata.name}`;
      cluster.set(key, { ...cluster.get(key), ...doc.stringData });
    }
    return '';
  }
  if (args[0] === '-n' && args[2] === 'get' && args[3] === 'deployments,statefulsets,daemonsets') {
    return JSON.stringify({ apiVersion: 'v1', kind: 'List', items: workloads[args[1]] ?? [] });
  }
  if (args[0] === '-n' && args[2] === 'rollout' && args[3] === 'restart') {
    return args
      .slice(4)
      .map((r) => `${r} restarted\n`)
      .join('');
  }
  if (
    args[0] === '-n' &&
    args[2] === 'annotate' &&
    args[3] === 'secret' &&
    args[5] === 'kubectl.kubernetes.io/last-applied-configuration-'
  ) {
    lastApplied.delete(`${args[1]}/${args[4]}`);
    return `secret/${args[4]} annotated\n`;
  }
  throw new Error(`the fake kubectl has no answer for: kubectl ${args.join(' ')}`);
}

vi.mock('../../../src/lib/command.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/command.js');
  return {
    ...actual,
    runCommandAsync: vi.fn(async (argv: string[], opts: { input?: string; env?: never }) => {
      calls.push({ argv, input: opts?.input, env: opts?.env });
      return fakeKubectl(argv.slice(1), opts?.input);
    }),
  };
});

const {
  applyCloudSecrets,
  CLOUD_SECRETS_APPLY_ARGV,
  readSecretFingerprints,
  secretDataChanged,
  secretReaders,
} = await import('../../../src/lib/deploy/k8s/k3s.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const { BaseProvider } = await import('../../../src/lib/providers/base.js');

/** Marks every place the token could leak; the rest makes it YAML-hostile. */
const MARK = 'vc-sentinel-token-7f3a';
const TOKEN = `${MARK}: "dq" 'sq' #hash \\bs {x}`;
const NETWORK = 4_210_337;
const KUBECONFIG = '/tmp/vc-test-kubeconfig';

const K8S_PROVIDERS = Object.entries(PROVIDERS).filter(([, P]) =>
  P.SUPPORTED_TIERS.includes('k8s'),
);
const OTHER_PROVIDERS = Object.entries(PROVIDERS).filter(
  ([, P]) => !P.SUPPORTED_TIERS.includes('k8s'),
);

/** What a template variable's value is, by the naming the boot scripts use. */
function valueFor(variable: string): string {
  if (variable === 'network_id') return String(NETWORK);
  if (variable.endsWith('_token') && variable !== 'k3s_token') return TOKEN;
  throw new Error(
    `a master boot script fills a Secret from \${${variable}}, which this census does not know`,
  );
}

describe('k8sCloudSecrets matches what the master boot script creates', () => {
  it('there are k8s providers to check', () => {
    expect(K8S_PROVIDERS.length).toBeGreaterThan(0);
  });

  it.each(K8S_PROVIDERS)('%s: same namespaces, names, keys and values', async (_id, Provider) => {
    const script = await Provider.getK8sMasterUserData({});
    const created = masterInitSecrets(script);
    expect(created.length).toBeGreaterThan(0);
    const fromScript = created.map(({ namespace, name, keys }) => ({
      namespace,
      name,
      stringData: Object.fromEntries(
        Object.entries(keys).map(([key, variable]) => [key, valueFor(variable)]),
      ),
    }));
    expect(Provider.k8sCloudSecrets({ token: TOKEN, networkId: NETWORK })).toEqual(fromScript);
  });

  it.each(OTHER_PROVIDERS)('%s has no k8s tier, so no cloud Secrets', (_id, Provider) => {
    expect(Provider.k8sCloudSecrets({ token: TOKEN, networkId: NETWORK })).toEqual([]);
  });

  it('the base class has none', () => {
    expect(BaseProvider.k8sCloudSecrets({ token: TOKEN })).toEqual([]);
  });
});

describe('applyCloudSecrets', () => {
  let logged: string[];

  beforeEach(() => {
    calls.length = 0;
    cluster.clear();
    lastApplied.clear();
    workloads = {};
    secretOutput = null;
    failWhen = null;
    kubectlFails = null;
    logged = [];
    const record = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const apply = (Provider: typeof BaseProvider, values = { token: TOKEN, networkId: NETWORK }) =>
    applyCloudSecrets({
      env: { ...process.env, KUBECONFIG },
      ProviderClass: Provider,
      stack: 'prod-primary',
      operatorEnv: 'prod',
      ...values,
    });
  const kubectl = (verb: string) =>
    calls.filter(({ argv }) => argv.includes(verb)).map(({ argv }) => argv);
  const applies = () => calls.filter(({ argv }) => argv[1] === 'apply');
  const restarts = () => kubectl('rollout');
  /**
   * Every Secret this provider hands over, as the cluster holds them with
   * `token`: after a deploy took them over, or (`boot`) as the master's boot
   * script left them, with kubectl's last-applied record of `token`.
   */
  const holdAll = (Provider: typeof BaseProvider, token: string, { boot = false } = {}) => {
    for (const { namespace, name, stringData } of Provider.k8sCloudSecrets({
      token,
      networkId: NETWORK,
    })) {
      cluster.set(`${namespace}/${name}`, { ...stringData });
      if (boot) lastApplied.set(`${namespace}/${name}`, { ...stringData });
    }
  };
  /** A Deployment whose container reads `secret`'s `key` into its env, as the upstream CCM/CSI do. */
  const envReader = (name: string, secret: string, key = 'token') => ({
    kind: 'Deployment',
    metadata: { name },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'c',
              env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: secret, key } } }],
            },
          ],
        },
      },
    },
  });
  const nonReaders = [
    envReader('reads-another-secret', 'carbon-autoscaler-config'),
    {
      kind: 'DaemonSet',
      metadata: { name: 'reads-nothing' },
      spec: { template: { spec: { containers: [{ name: 'c' }] } } },
    },
  ];
  /** One reader per Secret of this provider, beside two workloads that read none of them. */
  const readerPerSecret = (Provider: typeof BaseProvider) => {
    for (const { namespace, name } of Provider.k8sCloudSecrets({ token: TOKEN })) {
      workloads[namespace] = [...(workloads[namespace] ?? []), envReader(`reads-${name}`, name)];
    }
    for (const ns of Object.keys(workloads)) workloads[ns].push(...nonReaders);
  };

  it.each(K8S_PROVIDERS)(
    '%s: one server-side apply, owned by the CLI, every Secret on stdin',
    async (_id, Provider) => {
      await apply(Provider);
      expect(applies()).toHaveLength(1);
      const [{ argv, input, env }] = applies();
      expect(argv).toEqual(['kubectl', ...CLOUD_SECRETS_APPLY_ARGV]);
      expect(CLOUD_SECRETS_APPLY_ARGV).toEqual([
        'apply',
        '--server-side',
        '--force-conflicts',
        '--field-manager=vibecarbon-cli',
        '-f',
        '-',
      ]);
      expect(env?.KUBECONFIG).toBe(KUBECONFIG);
      const docs = loadAll(String(input));
      expect(docs).toEqual(
        Provider.k8sCloudSecrets({ token: TOKEN, networkId: NETWORK }).map(
          ({ namespace, name, stringData }) => ({
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name, namespace },
            type: 'Opaque',
            stringData,
          }),
        ),
      );
    },
  );

  it.each(K8S_PROVIDERS)(
    '%s: the token rides stdin only, never argv or a log line',
    async (_id, Provider) => {
      holdAll(Provider, 'vc-sentinel-token-old');
      readerPerSecret(Provider);
      await apply(Provider);
      expect(restarts()).toHaveLength(1);
      expect(String(applies()[0].input)).toContain(MARK);
      for (const { argv } of calls) expect(argv.join(' ')).not.toContain(MARK);
      expect(logged.join('\n')).not.toContain(MARK);
    },
  );

  it('says whose token goes where, naming every Secret', async () => {
    const lines: Record<string, string> = {};
    for (const [id, Provider] of K8S_PROVIDERS) {
      logged = [];
      await apply(Provider);
      lines[id] = logged.join('');
    }
    expect(lines).toEqual({
      hetzner:
        'Handing your Hetzner Cloud API token to the cluster (kube-system/hcloud, kube-system/hcloud-csi).',
      digitalocean:
        'Handing your DigitalOcean API token to the cluster (kube-system/digitalocean).',
      linode: 'Handing your Linode API token to the cluster (kube-system/linode).',
    });
  });

  it('a failed apply names the Secrets, never the token', async () => {
    failWhen = /^apply /;
    kubectlFails = Object.assign(new Error('Command failed: kubectl apply'), {
      status: 1,
      stderr: 'error: the server could not find the requested resource\n',
    });
    const err = await apply(PROVIDERS.hetzner).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('kube-system/hcloud');
    expect(err.message).not.toContain(MARK);
    expect(logged.join('\n')).not.toContain(MARK);
  });

  it.each(K8S_PROVIDERS)(
    '%s: no token, no kubectl, and where to set one',
    async (_id, Provider) => {
      for (const token of ['', undefined]) {
        await expect(apply(Provider, { token, networkId: NETWORK } as never)).rejects.toThrow(
          `Can't hand your ${Provider.NAME} API token to the cluster: this deploy has none. ` +
            `Set ${Provider.TOKEN_ENV} (in .env.local or your shell), then deploy again.`,
        );
      }
      expect(calls).toHaveLength(0);
      expect(logged).toEqual([]);
    },
  );

  it("Hetzner without the cluster's network id refuses before kubectl runs, and says how to refresh it", async () => {
    await expect(
      apply(PROVIDERS.hetzner, { token: TOKEN, networkId: undefined } as never),
    ).rejects.toThrow(
      "Can't hand your Hetzner Cloud API token to the cluster: the cluster outputs this deploy " +
        'saved have no network for Secret kube-system/hcloud. Delete ' +
        '.vibecarbon/deploy-state-prod-primary.json and run `vibecarbon deploy prod` again, ' +
        "so it reads them from the cluster's stack again.",
    );
    expect(calls).toHaveLength(0);
  });

  it.each(OTHER_PROVIDERS)('%s: nothing to hand over, nothing runs', async (_id, Provider) => {
    await apply(Provider);
    expect(calls).toHaveLength(0);
    expect(logged).toEqual([]);
  });

  describe('restarts what reads a changed Secret, and nothing else', () => {
    it.each(K8S_PROVIDERS)('%s: unchanged Secrets restart nothing', async (_id, Provider) => {
      holdAll(Provider, TOKEN);
      readerPerSecret(Provider);
      await apply(Provider);
      expect(applies()).toHaveLength(1);
      expect(kubectl('deployments,statefulsets,daemonsets')).toEqual([]);
      expect(restarts()).toEqual([]);
    });

    it.each(K8S_PROVIDERS)(
      '%s: a replaced token restarts exactly the workloads that read it',
      async (_id, Provider) => {
        holdAll(Provider, 'vc-sentinel-token-old');
        readerPerSecret(Provider);
        await apply(Provider);
        const secrets = Provider.k8sCloudSecrets({ token: TOKEN });
        const namespaces = [...new Set(secrets.map(({ namespace }) => namespace))];
        expect(restarts()).toEqual(
          namespaces.map((ns) => [
            'kubectl',
            '-n',
            ns,
            'rollout',
            'restart',
            ...secrets
              .filter(({ namespace }) => namespace === ns)
              .map(({ name }) => `deployment/reads-${name}`)
              .sort(),
          ]),
        );
        // After the apply: a pod that starts sooner would read the old token.
        const applyAt = calls.findIndex(({ argv }) => argv[1] === 'apply');
        const restartAt = calls.findIndex(({ argv }) => argv[3] === 'rollout');
        expect(restartAt).toBeGreaterThan(applyAt);
        // Found before it: a list that fails must leave the old value in place.
        const listAt = calls.findIndex(({ argv }) =>
          argv.includes('deployments,statefulsets,daemonsets'),
        );
        expect(listAt).toBeGreaterThan(-1);
        expect(listAt).toBeLessThan(applyAt);
      },
    );

    it('a list of what reads it that fails changes nothing, and says to deploy again', async () => {
      holdAll(PROVIDERS.linode, 'vc-sentinel-token-old');
      readerPerSecret(PROVIDERS.linode);
      failWhen = /^-n kube-system get deployments,statefulsets,daemonsets /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl get'), {
        status: 1,
        stderr: 'error: deployments.apps is forbidden\n',
      });
      const err = await apply(PROVIDERS.linode).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(
        "Couldn't list the workloads in kube-system to find what reads kube-system/linode, so " +
          'this deploy left it as it was. Deploy again to hand the new value over.\n' +
          'list the workloads in kube-system failed with exit 1: error: deployments.apps is forbidden',
      );
      // The next deploy finds the Secret still changed and does it all again.
      expect(applies()).toEqual([]);
      expect(cluster.get('kube-system/linode')).toEqual({ token: 'vc-sentinel-token-old' });
      expect(logged.join('\n')).not.toContain(MARK);
    });

    it.each(K8S_PROVIDERS)(
      '%s: Secrets this deploy creates restart nothing',
      async (_id, Provider) => {
        readerPerSecret(Provider);
        await apply(Provider);
        expect(applies()).toHaveLength(1);
        expect(restarts()).toEqual([]);
      },
    );

    it('only the Secret that changed: its readers restart, the other one’s do not', async () => {
      // hcloud already holds this token; hcloud-csi still the boot script's.
      holdAll(PROVIDERS.hetzner, TOKEN);
      cluster.set('kube-system/hcloud-csi', { token: 'vc-sentinel-token-old' });
      readerPerSecret(PROVIDERS.hetzner);
      await apply(PROVIDERS.hetzner);
      expect(restarts()).toEqual([
        ['kubectl', '-n', 'kube-system', 'rollout', 'restart', 'deployment/reads-hcloud-csi'],
      ]);
    });

    it('a changed Secret nothing reads restarts nothing', async () => {
      holdAll(PROVIDERS.linode, 'vc-sentinel-token-old');
      workloads['kube-system'] = [...nonReaders];
      await apply(PROVIDERS.linode);
      expect(kubectl('deployments,statefulsets,daemonsets')).toHaveLength(1);
      expect(restarts()).toEqual([]);
    });

    it('says what restarts and why, in one line', async () => {
      holdAll(PROVIDERS.hetzner, 'vc-sentinel-token-old');
      workloads['kube-system'] = [
        envReader('hcloud-cloud-controller-manager', 'hcloud'),
        envReader('hcloud-csi-controller', 'hcloud'),
        ...nonReaders,
      ];
      await apply(PROVIDERS.hetzner);
      // Both Secrets changed; only kube-system/hcloud has readers, as upstream.
      expect(logged).toEqual([
        'Handing your Hetzner Cloud API token to the cluster (kube-system/hcloud, kube-system/hcloud-csi).',
        'Restarting deployment/hcloud-cloud-controller-manager and deployment/hcloud-csi-controller ' +
          'so they pick up the new kube-system/hcloud: they read it only when they start.',
      ]);
      logged = [];
      cluster.set('kube-system/linode', { token: 'vc-sentinel-token-old' });
      workloads['kube-system'] = [envReader('csi-linode-controller', 'linode'), ...nonReaders];
      await apply(PROVIDERS.linode);
      expect(logged.at(-1)).toBe(
        'Restarting deployment/csi-linode-controller so it picks up the new kube-system/linode: ' +
          'it reads it only when it starts.',
      );
      logged = [];
      holdAll(PROVIDERS.hetzner, 'vc-sentinel-token-old');
      workloads['kube-system'] = [
        envReader('reads-hcloud', 'hcloud'),
        envReader('reads-hcloud-csi', 'hcloud-csi'),
      ];
      await apply(PROVIDERS.hetzner);
      expect(logged.at(-1)).toBe(
        'Restarting deployment/reads-hcloud and deployment/reads-hcloud-csi so they pick up the ' +
          'new kube-system/hcloud and kube-system/hcloud-csi: they read them only when they start.',
      );
    });

    it('a restart that fails says how to restart by hand, since the next deploy will not', async () => {
      holdAll(PROVIDERS.linode, 'vc-sentinel-token-old');
      readerPerSecret(PROVIDERS.linode);
      failWhen = /^-n kube-system rollout restart /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl rollout restart'), {
        status: 1,
        stderr: 'error: deployments.apps "reads-linode" is forbidden\n',
      });
      const err = await apply(PROVIDERS.linode).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(
        "kube-system/linode changed, but restarting deployment/reads-linode didn't go through, " +
          "so it still runs with the old value, and the next deploy won't restart it: the Secret " +
          `already matches. Run \`KUBECONFIG='${KUBECONFIG}' kubectl -n kube-system rollout restart ` +
          'deployment/reads-linode`.\nrestart deployment/reads-linode failed with exit 1: ' +
          'error: deployments.apps "reads-linode" is forbidden',
      );
      expect(logged.join('\n')).not.toContain(MARK);
    });
  });

  describe("drops the boot script's last-applied record, once", () => {
    // kubectl 1.24 and 1.25 keep it through the server-side takeover (the
    // Docker takeover test measures it), holding the token the boot script
    // applied; this fake apiserver keeps it the same way.
    const annotates = () => kubectl('annotate');
    const verbs = () => calls.map(({ argv }) => (argv[1] === 'apply' ? 'apply' : argv[3]));

    it.each(K8S_PROVIDERS)(
      '%s: each Secret the read found it on, after the apply, output captured, no token',
      async (_id, Provider) => {
        holdAll(Provider, 'vc-sentinel-token-boot', { boot: true });
        await apply(Provider);
        expect(annotates()).toEqual(
          Provider.k8sCloudSecrets({ token: TOKEN }).map(({ namespace, name }) => [
            'kubectl',
            '-n',
            namespace,
            'annotate',
            'secret',
            name,
            'kubectl.kubernetes.io/last-applied-configuration-',
          ]),
        );
        const applyAt = calls.findIndex(({ argv }) => argv[1] === 'apply');
        const firstAnnotate = calls.findIndex(({ argv }) => argv[3] === 'annotate');
        expect(firstAnnotate).toBeGreaterThan(applyAt);
        expect(lastApplied.size).toBe(0);
        for (const argv of annotates()) {
          expect(argv.join(' ')).not.toContain('vc-sentinel-token');
          expect(argv.join(' ')).not.toContain(MARK);
        }
        expect(logged.join('\n')).not.toContain('annotated');
      },
    );

    it.each(K8S_PROVIDERS)(
      '%s: none found, no call: a steady-state deploy is the reads and the apply',
      async (_id, Provider) => {
        holdAll(Provider, TOKEN);
        await apply(Provider);
        const reads = Provider.k8sCloudSecrets({ token: TOKEN }).map(() => 'get');
        expect(verbs()).toEqual([...reads, 'apply']);
      },
    );

    it('only the Secret that carries it', async () => {
      holdAll(PROVIDERS.hetzner, TOKEN);
      lastApplied.set('kube-system/hcloud-csi', { token: TOKEN });
      await apply(PROVIDERS.hetzner);
      expect(annotates().map((argv) => argv[5])).toEqual(['hcloud-csi']);
    });

    it('a Secret this deploy creates gets no call', async () => {
      await apply(PROVIDERS.linode);
      expect(annotates()).toEqual([]);
    });

    it('a failed removal warns with the command to run, and the deploy goes on', async () => {
      holdAll(PROVIDERS.linode, 'vc-sentinel-token-old', { boot: true });
      readerPerSecret(PROVIDERS.linode);
      failWhen = /^-n kube-system annotate secret linode /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl annotate'), {
        status: 1,
        stderr: 'error: secrets "linode" is forbidden\n',
      });
      await apply(PROVIDERS.linode);
      expect(logged).toContain(
        "Couldn't remove kubectl's last-applied record from kube-system/linode, which may hold " +
          'an earlier copy of your token; the next deploy tries again. To remove it now, run ' +
          `\`KUBECONFIG='${KUBECONFIG}' kubectl -n kube-system annotate secret linode ` +
          'kubectl.kubernetes.io/last-applied-configuration-`.\n' +
          'drop the last-applied record from Secret kube-system/linode failed with exit 1: ' +
          'error: secrets "linode" is forbidden',
      );
      // The token went over and its reader restarted all the same.
      expect(cluster.get('kube-system/linode')).toEqual({ token: TOKEN });
      expect(restarts()).toHaveLength(1);
      expect(logged.join('\n')).not.toContain('vc-sentinel-token-old');
      expect(logged.join('\n')).not.toContain(MARK);
    });
  });

  describe('the read before the apply never shows a value', () => {
    it.each(K8S_PROVIDERS)(
      '%s: nothing it read reaches stdout, stderr, a log line or an error',
      async (_id, Provider) => {
        // The Secret the cluster holds carries the token in data (base64)
        // and in the boot script's last-applied annotation (plain).
        holdAll(Provider, TOKEN, { boot: true });
        readerPerSecret(Provider);
        await apply(Provider, { token: 'vc-sentinel-token-new', networkId: NETWORK });
        const reads = kubectl('secret').filter((argv) => argv[3] === 'get');
        expect(reads.length).toBe(Provider.k8sCloudSecrets({ token: TOKEN }).length);
        const out = logged.join('\n');
        expect(out).not.toContain(MARK);
        expect(out).not.toContain(Buffer.from(TOKEN).toString('base64').slice(0, 16));
        expect(out).not.toContain('last-applied-configuration');
      },
    );

    it('output that is not JSON fails without quoting it', async () => {
      holdAll(PROVIDERS.digitalocean, TOKEN);
      secretOutput = `{"data": {"access-token": "${MARK}"`;
      const err = await apply(PROVIDERS.digitalocean).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(
        "kubectl's output for Secret kube-system/digitalocean was not the JSON it asks for.",
      );
      expect(logged.join('\n')).not.toContain(MARK);
      expect(applies()).toHaveLength(0);
    });

    it('keeps keyed digests and the annotation’s presence, never a value', async () => {
      const env = { ...process.env, KUBECONFIG };
      cluster.set('kube-system/hcloud', { token: TOKEN });
      lastApplied.set('kube-system/hcloud', { token: TOKEN });
      const live = await readSecretFingerprints({
        env,
        namespace: 'kube-system',
        name: 'hcloud',
        keys: ['token', 'network'],
      });
      expect(live).not.toBeNull();
      expect(Object.keys(live ?? {}).sort()).toEqual(['fingerprints', 'lastApplied']);
      expect(live?.lastApplied).toBe(true);
      expect(JSON.stringify(live)).not.toContain(MARK);
      expect(JSON.stringify(live)).not.toContain(
        Buffer.from(TOKEN).toString('base64').slice(0, 16),
      );
      expect(live?.fingerprints.network).toBe('');
      expect(secretDataChanged(live, { token: TOKEN })).toBe(false);
      expect(secretDataChanged(live, { token: `${TOKEN}x` })).toBe(true);
      expect(secretDataChanged(live, { token: TOKEN, network: String(NETWORK) })).toBe(true);
      lastApplied.clear();
      const taken = await readSecretFingerprints({
        env,
        namespace: 'kube-system',
        name: 'hcloud',
        keys: ['token'],
      });
      expect(taken?.lastApplied).toBe(false);
      const absent = await readSecretFingerprints({
        env,
        namespace: 'kube-system',
        name: 'hcloud-csi',
        keys: ['token'],
      });
      expect(absent).toBeNull();
      expect(secretDataChanged(absent, { token: TOKEN })).toBe(false);
    });
  });
});

describe('secretReaders', () => {
  const workload = (kind: string, name: string, pod: Record<string, unknown>) => ({
    kind,
    metadata: { name },
    spec: { template: { spec: pod } },
  });
  const ref = (secret: string) => ({ secretKeyRef: { name: secret, key: 'token' } });

  it('finds every way a pod reads a Secret, in every workload kind', () => {
    const list = {
      items: [
        workload('Deployment', 'env', {
          containers: [{ name: 'c', env: [{ name: 'T', valueFrom: ref('s') }] }],
        }),
        workload('StatefulSet', 'init-env', {
          containers: [{ name: 'c' }],
          initContainers: [{ name: 'i', env: [{ name: 'T', valueFrom: ref('s') }] }],
        }),
        workload('DaemonSet', 'env-from', {
          containers: [{ name: 'c', envFrom: [{ secretRef: { name: 's' } }] }],
        }),
        workload('Deployment', 'volume', {
          containers: [{ name: 'c' }],
          volumes: [{ name: 'v', secret: { secretName: 's' } }],
        }),
        workload('Deployment', 'projected', {
          containers: [{ name: 'c' }],
          volumes: [{ name: 'v', projected: { sources: [{ secret: { name: 's' } }] } }],
        }),
        workload('Deployment', 'ephemeral', {
          containers: [{ name: 'c' }],
          ephemeralContainers: [{ name: 'e', envFrom: [{ secretRef: { name: 's' } }] }],
        }),
      ],
    };
    expect(secretReaders(list, ['s'])).toEqual([
      'daemonset/env-from',
      'deployment/env',
      'deployment/ephemeral',
      'deployment/projected',
      'deployment/volume',
      'statefulset/init-env',
    ]);
  });

  it('leaves out what reads another Secret, a ConfigMap or nothing', () => {
    const list = {
      items: [
        workload('Deployment', 'other-secret', {
          containers: [{ name: 'c', env: [{ name: 'T', valueFrom: ref('other') }] }],
          volumes: [{ name: 'v', secret: { secretName: 'other' } }],
        }),
        workload('Deployment', 'configmap', {
          containers: [
            {
              name: 'c',
              env: [{ name: 'T', valueFrom: { configMapKeyRef: { name: 's', key: 'k' } } }],
              envFrom: [{ configMapRef: { name: 's' } }],
            },
          ],
          volumes: [{ name: 'v', configMap: { name: 's' } }],
        }),
        workload('DaemonSet', 'nothing', { containers: [{ name: 'c' }] }),
      ],
    };
    expect(secretReaders(list, ['s'])).toEqual([]);
  });

  it('names a reader of two of the Secrets once, and reads an empty list as none', () => {
    const both = workload('Deployment', 'both', {
      containers: [
        {
          name: 'c',
          env: [
            { name: 'A', valueFrom: ref('a') },
            { name: 'B', valueFrom: ref('b') },
          ],
        },
      ],
    });
    expect(secretReaders({ items: [both] }, ['a', 'b'])).toEqual(['deployment/both']);
    expect(secretReaders({ items: [] }, ['a'])).toEqual([]);
    expect(secretReaders({}, ['a'])).toEqual([]);
  });
});

describe('deployK3s hands the token over on every deploy', () => {
  const K3S = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');
  const BODY = K3S.slice(K3S.indexOf('async function deployK3sSteps('));
  const LINES = BODY.split('\n');
  const tpl = (s: string) => s.replaceAll('#{', '$' + '{');

  /** The text of the span `perfAsync(\`deploy.${perfPrefix}.<name>\`, ...)`, to its closing paren. */
  function span(name: string): { at: number; end: number; text: string } {
    const at = BODY.indexOf(tpl(`perfAsync(\`deploy.#{perfPrefix}.${name}\``));
    expect(at, `span ${name}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = at + 'perfAsync'.length; i < BODY.length; i++) {
      if (BODY[i] === '(') depth++;
      else if (BODY[i] === ')' && --depth === 0) {
        return { at, end: i + 1, text: BODY.slice(at, i + 1) };
      }
    }
    throw new Error(`unbalanced span ${name}`);
  }

  /** The line an offset into BODY sits on. */
  const lineOf = (at: number) => BODY.slice(0, at).split('\n').length - 1;
  const indent = (line: string) => line.length - line.trimStart().length;

  /** The opening line of every block around a line, innermost first. */
  function enclosingBlocks(lineNo: number): string[] {
    const blocks: string[] = [];
    let depth = indent(LINES[lineNo]);
    for (let i = lineNo - 1; i >= 0 && depth > 0; i--) {
      const line = LINES[i];
      if (line.trim() === '' || indent(line) >= depth) continue;
      blocks.push(line.trim());
      depth = indent(line);
    }
    return blocks;
  }

  it('applyCloudSecrets runs in its own span with the deploy token and this cluster', () => {
    const { text } = span('cloudSecrets');
    expect(text).toContain('applyCloudSecrets({');
    expect(text).toContain('env: kubeEnv');
    expect(text).toContain('ProviderClass: Provider');
    expect(text).toContain('token: options.apiToken');
    expect(text).toMatch(/\bnetworkId\b/);
    // The refusal's next step names this cluster's state file and the
    // environment the operator deploys.
    expect(text).toContain('stack: options.environment');
    expect(text).toContain('operatorEnv: options.operatorEnv ?? options.environment');
  });

  it('after the control-plane gate and the marker read, before the k3s-apply gate', () => {
    const order = [
      span('controlPlane.gate').at,
      span('restoreMarker').at,
      span('cloudSecrets').at,
      BODY.indexOf('await shouldSkipK3sApply('),
      BODY.indexOf('if (!skipApply) {'),
      BODY.indexOf('applyK3sManifests({'),
    ];
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('no condition guards it: a warm redeploy, deploy -restore and the k8s-ha standby run it', () => {
    const cloud = span('cloudSecrets');
    const line = LINES[lineOf(cloud.at)];
    // The statement is the span itself, not `if (...) await ...` or `x && ...`.
    expect(line.trim()).toBe(tpl('await perfAsync(`deploy.#{perfPrefix}.cloudSecrets`, () =>'));
    // In the bare block that holds the control-plane gate, at the top level of
    // deployK3sSteps: no if/else, loop, try or callback around it.
    const blocks = enclosingBlocks(lineOf(cloud.at));
    expect(blocks).toEqual(['{', 'async function deployK3sSteps(options, inFlight) {']);
    expect(enclosingBlocks(lineOf(span('controlPlane.gate').at))).toEqual(blocks);
    // The marker read ends; the next statement is this one.
    const between = BODY.slice(span('restoreMarker').end, cloud.at).replace(/\/\/.*$/gm, '');
    expect(between.replace(/\s+/g, '')).toBe(';await');
  });

  it('networkId is this cluster’s own k3s-infra output', () => {
    const infra = BODY.indexOf("const infraOutputs = state.getStepResult('k3s-infra');");
    const destructure = BODY.slice(infra, BODY.indexOf('} = infraOutputs;', infra));
    expect(destructure).toMatch(/^\s+networkId,$/m);
  });
});
