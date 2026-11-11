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
 *   - census: each k8s provider's k8sCloudSecrets names exactly the Secrets
 *     and keys the upstream manifests its master boot script applies
 *     require (a record of their secretKeyRefs,
 *     tests/_shared/cloud-secret-readers.ts, held to the URLs the script
 *     applies), each holding the token, and every reference reads one of
 *     them; K8S_RETIRED_CLOUD_SECRETS is what the old boot scripts made
 *     (tests/_shared/legacy-master-init-secrets.ts) less that, and nothing
 *     reads it; the cluster autoscaler reads only its own Secret; a provider
 *     without a k8s tier hands over nothing;
 *   - applyCloudSecrets: one `kubectl apply --server-side --force-conflicts
 *     --field-manager=vibecarbon-cli -f -`, with every Secret on stdin; the
 *     token never on argv, never in a log line or the error; no token
 *     refuses before kubectl runs, saying what to do next;
 *   - restarts: each Secret is read before the apply, its values kept as
 *     keyed digests and never printed; a Secret this deploy changes restarts
 *     exactly the workloads that read it (found from their pod templates,
 *     secretReaders); an unchanged one, or one it creates, restarts nothing
 *     and lists nothing (the kubelet starts a reader waiting for a new one,
 *     tests/integration/docker/k8s-secret-readers-restart.test.ts); a failed
 *     restart fails the deploy with the command to run;
 *   - the retired ones: a master an earlier vibecarbon booted ends with
 *     exactly the CLI's Secrets and keys, a whole Secret deleted alongside the
 *     reads, a key patched out after the apply, each said once, and a failure
 *     warns with the command and goes on;
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
 * That a server-side apply takes over Secrets an old boot script made with a
 * client-side `kubectl apply` without a conflict, and what the apply alone
 * leaves of the retired ones, needs a real apiserver:
 * tests/integration/docker/k8s-cloud-secrets-takeover.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_SECRET_READERS, manifestUrls } from '../../_shared/cloud-secret-readers.js';
import { LEGACY_MASTER_INIT_SECRETS } from '../../_shared/legacy-master-init-secrets.js';
import { masterInitSecrets } from '../../_shared/master-init-secrets.js';

type Call = { argv: string[]; input?: string; env?: NodeJS.ProcessEnv };
const calls: Call[] = [];
/** A kubectl call whose argv (after `kubectl`) this matches fails with kubectlFails. */
let failWhen: RegExp | null = null;
let kubectlFails: Error | null = null;

/** The Secrets the fake apiserver holds, `namespace/name` to decoded data. */
const cluster = new Map<string, Record<string, string>>();
/** A workload as `get deployments,statefulsets,daemonsets -o json` lists it. */
type Workload = {
  kind: string;
  metadata: { name: string };
  spec: { strategy?: Record<string, unknown>; template: { spec: Record<string, unknown> } };
};
/** The pod templates `get deployments,statefulsets,daemonsets -o json` lists, per namespace. */
let workloads: Record<string, Workload[]> = {};
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

/**
 * kubectl against `cluster`: reads, the server-side apply, the workload list,
 * strategy patches, restarts and rollout waits.
 */
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
  if (args[0] === '-n' && args[2] === 'rollout' && args[3] === 'status') {
    return `${args[4]} successfully rolled out\n`;
  }
  if (
    args[0] === '-n' &&
    args[2] === 'patch' &&
    args[3].startsWith('deployment/') &&
    args[4] === '--type=merge'
  ) {
    const item = (workloads[args[1]] ?? []).find(
      (w) => w.kind === 'Deployment' && `deployment/${w.metadata.name}` === args[3],
    );
    if (!item) throw new Error(`Error from server (NotFound): ${args[3]} not found`);
    const { strategy } = (JSON.parse(args[6]) as { spec: { strategy: Record<string, unknown> } })
      .spec;
    item.spec.strategy = Object.fromEntries(Object.entries(strategy).filter(([, v]) => v !== null));
    return `${args[3].replace('deployment/', 'deployment.apps/')} patched\n`;
  }
  if (args[0] === '-n' && args[2] === 'delete' && args[3] === 'secret') {
    const key = `${args[1]}/${args[4]}`;
    if (!cluster.has(key)) return '';
    cluster.delete(key);
    lastApplied.delete(key);
    return `secret "${args[4]}" deleted\n`;
  }
  if (
    args[0] === '-n' &&
    args[2] === 'patch' &&
    args[3] === 'secret' &&
    args[5] === '--type=merge'
  ) {
    const key = `${args[1]}/${args[4]}`;
    const data = cluster.get(key);
    if (!data) throw new Error(`Error from server (NotFound): secrets "${args[4]}" not found`);
    const { data: patch } = JSON.parse(args[7]) as { data: Record<string, null> };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete data[k];
    return `secret/${args[4]} patched\n`;
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
  restartSecretReaders,
  secretDataChanged,
  secretReaders,
  takesHostPorts,
} = await import('../../../src/lib/deploy/k8s/k3s.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const { BaseProvider } = await import('../../../src/lib/providers/base.js');

/** Marks every place the token could leak; the rest makes it YAML-hostile. */
const MARK = 'vc-sentinel-token-7f3a';
const TOKEN = `${MARK}: "dq" 'sq' #hash \\bs {x}`;
const NETWORK = '4210337';
const KUBECONFIG = '/tmp/vc-test-kubeconfig';

const K8S_PROVIDERS = Object.entries(PROVIDERS).filter(([, P]) =>
  P.SUPPORTED_TIERS.includes('k8s'),
);
const OTHER_PROVIDERS = Object.entries(PROVIDERS).filter(
  ([, P]) => !P.SUPPORTED_TIERS.includes('k8s'),
);

/** What an old boot script rendered for a template variable, by the naming they used. */
function legacyValue(variable: string, token: string): string {
  if (variable === 'network_id') return NETWORK;
  if (variable.endsWith('_token') && variable !== 'k3s_token') return token;
  throw new Error(
    `an old master boot script filled a Secret from \${${variable}}, which this census does not know`,
  );
}

/** A Secret key as one string, for set comparisons. */
const keyAt = (namespace: string, secret: string, key: string) => `${namespace}/${secret}:${key}`;
const byName = (a: { namespace: string; name: string }, b: { namespace: string; name: string }) =>
  `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);

describe('k8sCloudSecrets is exactly what the upstream manifests read', () => {
  it('there are k8s providers to check, each with a record of its readers', () => {
    expect(K8S_PROVIDERS.length).toBeGreaterThan(0);
    expect(Object.keys(CLOUD_SECRET_READERS).sort()).toEqual(
      K8S_PROVIDERS.map(([id]) => id).sort(),
    );
  });

  it.each(K8S_PROVIDERS)(
    '%s: the record is of the manifests its master boot script applies',
    async (id, Provider) => {
      const script = await Provider.getK8sMasterUserData({});
      expect(manifestUrls(script)).toEqual(CLOUD_SECRET_READERS[id].manifests);
    },
  );

  it.each(K8S_PROVIDERS)(
    '%s: every key a reader requires and no other, each holding the token',
    (id, Provider) => {
      const secrets = Provider.k8sCloudSecrets({ token: TOKEN });
      const written = secrets.flatMap(({ namespace, name, stringData }) =>
        Object.keys(stringData).map((key) => keyAt(namespace, name, key)),
      );
      const required = CLOUD_SECRET_READERS[id].refs
        .filter(({ optional }) => !optional)
        .map(({ namespace, secret, key }) => keyAt(namespace, secret, key));
      expect(written.sort()).toEqual([...new Set(required)].sort());
      for (const { stringData } of secrets) {
        for (const value of Object.values(stringData)) expect(value).toBe(TOKEN);
      }
      // An optional key reads one of these Secrets too, so nothing reads a
      // Secret the CLI does not write.
      const names = new Set(secrets.map(({ namespace, name }) => `${namespace}/${name}`));
      for (const { namespace, secret } of CLOUD_SECRET_READERS[id].refs) {
        expect(names).toContain(`${namespace}/${secret}`);
      }
    },
  );

  it.each(OTHER_PROVIDERS)('%s has no k8s tier, so no cloud Secrets', (_id, Provider) => {
    expect(Provider.k8sCloudSecrets({ token: TOKEN })).toEqual([]);
    expect(Provider.K8S_RETIRED_CLOUD_SECRETS).toEqual([]);
  });

  it('the base class has none', () => {
    expect(BaseProvider.k8sCloudSecrets({ token: TOKEN })).toEqual([]);
    expect(BaseProvider.K8S_RETIRED_CLOUD_SECRETS).toEqual([]);
  });

  it('the cluster autoscaler reads only its own Secret, none of these', () => {
    const docs = loadAll(
      readFileSync(
        join(__dirname, '../../../carbon/k8s/base/cluster-autoscaler/deployment.yaml'),
        'utf-8',
      ),
    ) as { spec?: { template?: { spec?: Record<string, never> } } }[];
    const read = new Set<string>();
    for (const doc of docs) {
      const pod = (doc?.spec?.template?.spec ?? {}) as {
        containers?: { env?: { valueFrom?: { secretKeyRef?: { name: string } } }[] }[];
        volumes?: { secret?: { secretName: string } }[];
      };
      for (const c of pod.containers ?? []) {
        for (const e of c.env ?? []) {
          if (e.valueFrom?.secretKeyRef) read.add(e.valueFrom.secretKeyRef.name);
        }
      }
      for (const v of pod.volumes ?? []) if (v.secret) read.add(v.secret.secretName);
    }
    expect([...read]).toEqual(['carbon-autoscaler-config']);
  });
});

describe('K8S_RETIRED_CLOUD_SECRETS is what the old boot scripts made and the CLI no longer writes', () => {
  it('there is a record for every k8s provider', () => {
    expect(Object.keys(LEGACY_MASTER_INIT_SECRETS).sort()).toEqual(
      K8S_PROVIDERS.map(([id]) => id).sort(),
    );
  });

  it.each(K8S_PROVIDERS)('%s: the old Secrets and keys less the current ones', (id, Provider) => {
    const written = Provider.k8sCloudSecrets({ token: TOKEN });
    const expected: { namespace: string; name: string; keys?: string[] }[] = [];
    for (const { namespace, name, keys } of masterInitSecrets(LEGACY_MASTER_INIT_SECRETS[id])) {
      const kept = written.find((w) => w.namespace === namespace && w.name === name);
      if (!kept) {
        expected.push({ namespace, name });
        continue;
      }
      const gone = Object.keys(keys).filter((key) => !(key in kept.stringData));
      if (gone.length > 0) expected.push({ namespace, name, keys: gone });
    }
    expect([...Provider.K8S_RETIRED_CLOUD_SECRETS].sort(byName)).toEqual(expected.sort(byName));
  });

  it.each(K8S_PROVIDERS)('%s: nothing upstream reads a retired one', (id, Provider) => {
    for (const { namespace, secret, key } of CLOUD_SECRET_READERS[id].refs) {
      for (const retired of Provider.K8S_RETIRED_CLOUD_SECRETS) {
        const reads =
          retired.namespace === namespace &&
          retired.name === secret &&
          (!retired.keys || retired.keys.includes(key));
        expect(reads, `${namespace}/${secret}:${key}`).toBe(false);
      }
    }
  });

  it.each(K8S_PROVIDERS)(
    '%s: the record is of the past: the boot script creates no Secret now',
    async (id, Provider) => {
      expect(masterInitSecrets(LEGACY_MASTER_INIT_SECRETS[id]).length).toBeGreaterThan(0);
      expect(masterInitSecrets(await Provider.getK8sMasterUserData({}))).toEqual([]);
    },
  );
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

  /** applyCloudSecrets with TOKEN, or with the token given, undefined included. */
  const apply = (Provider: typeof BaseProvider, ...token: [string?]) =>
    applyCloudSecrets({
      env: { ...process.env, KUBECONFIG },
      ProviderClass: Provider,
      token: token.length > 0 ? token[0] : TOKEN,
    });
  const kubectl = (verb: string) =>
    calls.filter(({ argv }) => argv.includes(verb)).map(({ argv }) => argv);
  const applies = () => calls.filter(({ argv }) => argv[1] === 'apply');
  const rollout = (verb: string) =>
    calls.filter(({ argv }) => argv[3] === 'rollout' && argv[4] === verb).map(({ argv }) => argv);
  const restarts = () => rollout('restart');
  const waits = () => rollout('status');
  const strategyPatches = () =>
    calls
      .filter(({ argv }) => argv[3] === 'patch' && argv[4].startsWith('deployment/'))
      .map(({ argv }) => argv);
  /**
   * Every Secret this provider hands over, as the cluster holds them with
   * `token`: after a deploy took them over, or (`boot`) as the master's boot
   * script left them, with kubectl's last-applied record of `token`.
   */
  const holdAll = (Provider: typeof BaseProvider, token: string, { boot = false } = {}) => {
    for (const { namespace, name, stringData } of Provider.k8sCloudSecrets({ token })) {
      cluster.set(`${namespace}/${name}`, { ...stringData });
      if (boot) lastApplied.set(`${namespace}/${name}`, { ...stringData });
    }
  };
  /** A Deployment whose container reads `secret`'s `key` into its env, as the upstream CCM/CSI do. */
  const envReader = (name: string, secret: string, key = 'token'): Workload => ({
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
  /** envReader with `kind`, its pod spec, its container and its spec added to. */
  const readerLike = (
    name: string,
    secret: string,
    {
      kind = 'Deployment',
      pod = {},
      container = {},
      spec = {},
    }: {
      kind?: string;
      pod?: Record<string, unknown>;
      container?: Record<string, unknown>;
      spec?: Record<string, unknown>;
    },
  ): Workload => {
    const base = envReader(name, secret);
    const [c] = base.spec.template.spec.containers as Record<string, unknown>[];
    return {
      kind,
      metadata: base.metadata,
      spec: {
        ...spec,
        template: { spec: { ...pod, containers: [{ ...c, ...container }] } },
      },
    };
  };
  const nonReaders: Workload[] = [
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
  /**
   * What a master an earlier vibecarbon booted holds: its boot script's
   * Secrets with `token`, and their last-applied record.
   */
  const holdLegacy = (Provider: typeof BaseProvider, token: string) => {
    const id = Object.entries(PROVIDERS).find(([, P]) => P === Provider)?.[0] ?? '';
    for (const { namespace, name, keys } of masterInitSecrets(LEGACY_MASTER_INIT_SECRETS[id])) {
      const data = Object.fromEntries(
        Object.entries(keys).map(([key, variable]) => [key, legacyValue(variable, token)]),
      );
      cluster.set(`${namespace}/${name}`, data);
      lastApplied.set(`${namespace}/${name}`, { ...data });
    }
  };
  /** A provider whose token goes into two Secrets in one namespace. */
  class TwoSecrets extends BaseProvider {
    static NAME = 'Two Secrets Cloud';
    static TOKEN_ENV = 'TWO_SECRETS_TOKEN';
    static k8sCloudSecrets({ token }: { token: string }) {
      return [
        { namespace: 'kube-system', name: 'one', stringData: { token } },
        { namespace: 'kube-system', name: 'two', stringData: { token } },
      ];
    }
  }

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
        Provider.k8sCloudSecrets({ token: TOKEN }).map(({ namespace, name, stringData }) => ({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name, namespace },
          type: 'Opaque',
          stringData,
        })),
      );
    },
  );

  it.each(K8S_PROVIDERS)(
    '%s: the token rides stdin only, never argv or a log line',
    async (_id, Provider) => {
      // An old master's Secrets, so the cleanup's calls are checked too.
      holdLegacy(Provider, 'vc-sentinel-token-old');
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
      hetzner: 'Handing your Hetzner Cloud API token to the cluster (kube-system/hcloud).',
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
        await expect(apply(Provider, token)).rejects.toThrow(
          `Can't hand your ${Provider.NAME} API token to the cluster: this deploy has none. ` +
            `Set ${Provider.TOKEN_ENV} (in .env.local or your shell), then deploy again.`,
        );
      }
      expect(calls).toHaveLength(0);
      expect(logged).toEqual([]);
    },
  );

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
      '%s: Secrets this deploy creates restart nothing and list nothing',
      async (_id, Provider) => {
        // Waiting since the master booted: the kubelet starts each on its own
        // retry, and a restart would start a StatefulSet's pod twice.
        readerPerSecret(Provider);
        await apply(Provider);
        expect(applies()).toHaveLength(1);
        expect(kubectl('deployments,statefulsets,daemonsets')).toEqual([]);
        expect(restarts()).toEqual([]);
        expect(logged).toEqual([
          `Handing your ${Provider.NAME} API token to the cluster (${Provider.k8sCloudSecrets({
            token: TOKEN,
          })
            .map(({ namespace, name }) => `${namespace}/${name}`)
            .join(', ')}).`,
        ]);
      },
    );

    it('a workload list that would fail cannot fail a first deploy: none is asked for', async () => {
      readerPerSecret(PROVIDERS.linode);
      failWhen = /^-n kube-system get deployments,statefulsets,daemonsets /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl get'), {
        status: 1,
        stderr: 'error: deployments.apps is forbidden\n',
      });
      await apply(PROVIDERS.linode);
      expect(cluster.get('kube-system/linode')).toEqual({ token: TOKEN });
      expect(restarts()).toEqual([]);
    });

    it('one Secret new and one changed in a namespace: only the changed one’s readers restart', async () => {
      cluster.set('kube-system/one', { token: 'vc-sentinel-token-old' });
      workloads['kube-system'] = [envReader('reads-one', 'one'), envReader('reads-two', 'two')];
      await apply(TwoSecrets);
      expect(restarts()).toEqual([
        ['kubectl', '-n', 'kube-system', 'rollout', 'restart', 'deployment/reads-one'],
      ]);
      expect(logged.at(-1)).toBe(
        'Restarting deployment/reads-one so it picks up the new kube-system/one: it reads it ' +
          'only when it starts.',
      );
    });

    it('only the Secret that changed: its readers restart, the other one’s do not', async () => {
      cluster.set('kube-system/one', { token: TOKEN });
      cluster.set('kube-system/two', { token: 'vc-sentinel-token-old' });
      workloads['kube-system'] = [envReader('reads-one', 'one'), envReader('reads-two', 'two')];
      await apply(TwoSecrets);
      expect(restarts()).toEqual([
        ['kubectl', '-n', 'kube-system', 'rollout', 'restart', 'deployment/reads-two'],
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
      expect(logged).toEqual([
        'Handing your Hetzner Cloud API token to the cluster (kube-system/hcloud).',
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
      holdAll(TwoSecrets, 'vc-sentinel-token-old');
      workloads['kube-system'] = [envReader('reads-one', 'one'), envReader('reads-two', 'two')];
      await apply(TwoSecrets);
      expect(logged.at(-1)).toBe(
        'Restarting deployment/reads-one and deployment/reads-two so they pick up the ' +
          'new kube-system/one and kube-system/two: they read them only when they start.',
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

    it.each(K8S_PROVIDERS)(
      '%s: waits for each restarted reader, so a deploy that succeeds left none on the old token',
      async (_id, Provider) => {
        holdAll(Provider, 'vc-sentinel-token-old');
        readerPerSecret(Provider);
        await apply(Provider);
        const restarted = restarts().flatMap((argv) => argv.slice(5).map((w) => [argv[2], w]));
        expect(restarted.length).toBeGreaterThan(0);
        expect(waits()).toEqual(
          restarted.map(([ns, w]) => [
            'kubectl',
            '-n',
            ns,
            'rollout',
            'status',
            w,
            '--timeout=300s',
          ]),
        );
        // After the restart it waits for.
        const restartAt = calls.findIndex(({ argv }) => argv[4] === 'restart');
        const firstWaitAt = calls.findIndex(({ argv }) => argv[4] === 'status');
        expect(firstWaitAt).toBeGreaterThan(restartAt);
      },
    );

    it('moves a reader whose pods take a port on their node to Recreate first, and only such a one', async () => {
      holdAll(PROVIDERS.digitalocean, 'vc-sentinel-token-old');
      const s = 'digitalocean';
      workloads['kube-system'] = [
        // hostNetwork on upstream's default strategy, as the DigitalOcean CCM.
        readerLike('host-net', s, { pod: { hostNetwork: true } }),
        readerLike('host-port', s, {
          container: { ports: [{ containerPort: 10258, hostPort: 10258 }] },
        }),
        readerLike('init-host-port', s, {
          pod: { initContainers: [{ name: 'i', ports: [{ containerPort: 9, hostPort: 9 }] }] },
        }),
        readerLike('host-net-rolling', s, {
          pod: { hostNetwork: true },
          spec: { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1 } } },
        }),
        // Already Recreate, as the cluster autoscaler: nothing to move.
        readerLike('host-net-recreate', s, {
          pod: { hostNetwork: true },
          spec: { strategy: { type: 'Recreate' } },
        }),
        // A StatefulSet deletes before it creates, a DaemonSet replaces one
        // node's pod at a time.
        readerLike('host-net-sts', s, { kind: 'StatefulSet', pod: { hostNetwork: true } }),
        readerLike('host-net-ds', s, { kind: 'DaemonSet', pod: { hostNetwork: true } }),
        readerLike('container-port', s, { container: { ports: [{ containerPort: 8080 }] } }),
        readerLike('host-network-false', s, { pod: { hostNetwork: false } }),
        // A StatefulSet that takes a port and a Deployment that doesn't, one name.
        readerLike('twin', s, { kind: 'StatefulSet', pod: { hostNetwork: true } }),
        readerLike('twin', s, {}),
        // Takes a port, reads none of these Secrets: not restarted, not moved.
        readerLike('reads-another', 'carbon-autoscaler-config', { pod: { hostNetwork: true } }),
      ];
      await apply(PROVIDERS.digitalocean);
      const PATCH = '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}';
      expect(strategyPatches()).toEqual(
        ['host-net', 'host-net-rolling', 'host-port', 'init-host-port'].map((w) => [
          'kubectl',
          '-n',
          'kube-system',
          'patch',
          `deployment/${w}`,
          '--type=merge',
          '-p',
          PATCH,
        ]),
      );
      // Before the restart: on a rolling update its rollout would never finish.
      const lastPatchAt = calls.findLastIndex(({ argv }) => argv[3] === 'patch');
      const restartAt = calls.findIndex(({ argv }) => argv[4] === 'restart');
      expect(lastPatchAt).toBeLessThan(restartAt);
      const strategy = (name: string) =>
        workloads['kube-system'].find((w) => w.metadata.name === name)?.spec.strategy;
      expect(strategy('host-net')).toEqual({ type: 'Recreate' });
      expect(strategy('host-net-rolling')).toEqual({ type: 'Recreate' });
      // Every reader restarts and is waited for, moved or not.
      expect(restarts()).toEqual([
        [
          'kubectl',
          '-n',
          'kube-system',
          'rollout',
          'restart',
          'daemonset/host-net-ds',
          'deployment/container-port',
          'deployment/host-net',
          'deployment/host-net-recreate',
          'deployment/host-net-rolling',
          'deployment/host-network-false',
          'deployment/host-port',
          'deployment/init-host-port',
          'deployment/twin',
          'statefulset/host-net-sts',
          'statefulset/twin',
        ],
      ]);
      expect(waits()).toHaveLength(11);
    });

    it('says why it moves one to Recreate, in the line after the restart line', async () => {
      holdAll(PROVIDERS.digitalocean, 'vc-sentinel-token-old');
      workloads['kube-system'] = [
        readerLike('digitalocean-cloud-controller-manager', 'digitalocean', {
          pod: { hostNetwork: true },
        }),
        readerLike('csi-do-controller', 'digitalocean', { kind: 'StatefulSet' }),
      ];
      await apply(PROVIDERS.digitalocean);
      expect(logged).toEqual([
        'Handing your DigitalOcean API token to the cluster (kube-system/digitalocean).',
        'Restarting deployment/digitalocean-cloud-controller-manager and statefulset/csi-do-controller ' +
          'so they pick up the new kube-system/digitalocean: they read it only when they start.',
        'Moving deployment/digitalocean-cloud-controller-manager to the Recreate strategy first: ' +
          "its pod takes a port on its node, so a new pod can't start beside the old one, and a " +
          'rolling update would keep the old one running with the old value.',
      ]);
      // The next rotation finds it on Recreate: no second move.
      logged = [];
      calls.length = 0;
      cluster.set('kube-system/digitalocean', { 'access-token': 'vc-sentinel-token-older' });
      await apply(PROVIDERS.digitalocean);
      expect(strategyPatches()).toEqual([]);
      expect(restarts()).toHaveLength(1);
    });

    it('a strategy patch that fails restarts nothing and says what to run, since the next deploy will not', async () => {
      holdAll(PROVIDERS.digitalocean, 'vc-sentinel-token-old');
      workloads['kube-system'] = [
        readerLike('digitalocean-cloud-controller-manager', 'digitalocean', {
          pod: { hostNetwork: true },
        }),
        readerLike('csi-do-controller', 'digitalocean', { kind: 'StatefulSet' }),
      ];
      failWhen = /^-n kube-system patch deployment\//;
      kubectlFails = Object.assign(new Error('Command failed: kubectl patch'), {
        status: 1,
        stderr: 'error: deployments.apps "digitalocean-cloud-controller-manager" is forbidden\n',
      });
      const err = await apply(PROVIDERS.digitalocean).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const kc = `KUBECONFIG='${KUBECONFIG}' kubectl -n kube-system`;
      expect(err.message).toBe(
        'kube-system/digitalocean changed, but moving deployment/digitalocean-cloud-controller-manager ' +
          "to the Recreate strategy didn't go through, so this deploy restarted nothing and " +
          'deployment/digitalocean-cloud-controller-manager and statefulset/csi-do-controller still ' +
          "run with the old value. The next deploy won't restart them: the Secret already matches. " +
          `Run \`${kc} patch deployment/digitalocean-cloud-controller-manager --type=merge -p ` +
          `'{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'\`, then \`${kc} rollout ` +
          'restart deployment/digitalocean-cloud-controller-manager statefulset/csi-do-controller`.\n' +
          'move deployment/digitalocean-cloud-controller-manager to the Recreate strategy failed ' +
          'with exit 1: error: deployments.apps "digitalocean-cloud-controller-manager" is forbidden',
      );
      expect(restarts()).toEqual([]);
      expect(waits()).toEqual([]);
      expect(logged.join('\n')).not.toContain(MARK);
    });

    it('a reader that does not finish restarting fails the deploy, by name, and says not to revoke the old token yet', async () => {
      holdAll(PROVIDERS.hetzner, 'vc-sentinel-token-old');
      workloads['kube-system'] = [
        envReader('hcloud-cloud-controller-manager', 'hcloud'),
        envReader('hcloud-csi-controller', 'hcloud'),
      ];
      failWhen = /^-n kube-system rollout status deployment\/hcloud-csi-controller /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl rollout status'), {
        status: 1,
        stderr: 'error: timed out waiting for the condition\n',
      });
      const err = await apply(PROVIDERS.hetzner).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(
        "deployment/hcloud-csi-controller in kube-system didn't finish restarting within 300 s, " +
          "so it may still run with the old kube-system/hcloud, and the next deploy won't restart " +
          "it again: the Secret already matches. Don't revoke your old token until it has. See " +
          `where it stands with \`KUBECONFIG='${KUBECONFIG}' kubectl -n kube-system rollout status ` +
          'deployment/hcloud-csi-controller`.\nwait for deployment/hcloud-csi-controller to restart ' +
          'failed with exit 1: error: timed out waiting for the condition',
      );
      // Each was waited for, the one that finished too: one stuck reader
      // never hides another.
      expect(waits().map((argv) => argv[5])).toEqual([
        'deployment/hcloud-cloud-controller-manager',
        'deployment/hcloud-csi-controller',
      ]);
      // Not a retry: a rollout that did not finish in 300 s is not a blip.
      expect(
        calls.filter(
          ({ argv }) => argv.includes('deployment/hcloud-csi-controller') && argv[4] === 'status',
        ),
      ).toHaveLength(1);
    });

    it('two readers that do not finish: both named, in one error', async () => {
      holdAll(PROVIDERS.hetzner, 'vc-sentinel-token-old');
      workloads['kube-system'] = [
        envReader('hcloud-cloud-controller-manager', 'hcloud'),
        envReader('hcloud-csi-controller', 'hcloud'),
      ];
      failWhen = /^-n kube-system rollout status /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl rollout status'), {
        status: 1,
        stderr: 'error: timed out waiting for the condition\n',
      });
      const err = await apply(PROVIDERS.hetzner).catch((e: Error) => e);
      expect(err.message.split('\n')[0]).toBe(
        'deployment/hcloud-cloud-controller-manager and deployment/hcloud-csi-controller in ' +
          "kube-system didn't finish restarting within 300 s, so they may still run with the old " +
          "kube-system/hcloud, and the next deploy won't restart them again: the Secret already " +
          "matches. Don't revoke your old token until they have. See where they stand with " +
          `\`KUBECONFIG='${KUBECONFIG}' kubectl -n kube-system rollout status ` +
          'deployment/hcloud-cloud-controller-manager deployment/hcloud-csi-controller`.',
      );
    });

    it('wait: false restarts and leaves the wait to its caller', async () => {
      const found = {
        namespace: 'kube-system',
        readers: ['deployment/cluster-autoscaler'],
        read: ['carbon-autoscaler-config'],
        recreate: [],
      };
      await restartSecretReaders({ env: { KUBECONFIG }, ...found, wait: false });
      expect(restarts()).toHaveLength(1);
      expect(waits()).toEqual([]);
      await restartSecretReaders({ env: { KUBECONFIG }, ...found });
      expect(waits()).toHaveLength(1);
    });
  });

  describe('removes what an earlier vibecarbon wrote and nothing reads', () => {
    it.each(K8S_PROVIDERS)(
      '%s: an old master ends with exactly the Secrets and keys the CLI writes',
      async (id, Provider) => {
        holdLegacy(Provider, 'vc-sentinel-token-old');
        readerPerSecret(Provider);
        await apply(Provider);
        const legacy = masterInitSecrets(LEGACY_MASTER_INIT_SECRETS[id]);
        const written = Provider.k8sCloudSecrets({ token: TOKEN });
        for (const { namespace, name } of legacy) {
          const kept = written.find((w) => w.namespace === namespace && w.name === name);
          expect(cluster.get(`${namespace}/${name}`), `${namespace}/${name}`).toEqual(
            kept?.stringData,
          );
        }
        for (const { argv } of calls) expect(argv.join(' ')).not.toContain('vc-sentinel-token');
        expect(logged.join('\n')).not.toContain('vc-sentinel-token');
      },
    );

    it('hetzner: says what it removed, once', async () => {
      holdLegacy(PROVIDERS.hetzner, TOKEN);
      await apply(PROVIDERS.hetzner);
      expect(logged).toEqual([
        'Handing your Hetzner Cloud API token to the cluster (kube-system/hcloud).',
        'Removed kube-system/hcloud-csi, an extra copy of your Hetzner Cloud API token that ' +
          'nothing reads.',
        'Removed the network key from kube-system/hcloud: nothing reads it any more.',
      ]);
      expect(kubectl('patch')).toEqual([
        [
          'kubectl',
          '-n',
          'kube-system',
          'patch',
          'secret',
          'hcloud',
          '--type=merge',
          '-p',
          '{"data":{"network":null}}',
        ],
      ]);
      // The next deploy finds nothing to remove: a quiet delete, no patch.
      calls.length = 0;
      logged = [];
      await apply(PROVIDERS.hetzner);
      expect(logged).toEqual([
        'Handing your Hetzner Cloud API token to the cluster (kube-system/hcloud).',
      ]);
      expect(kubectl('patch')).toEqual([]);
      expect(kubectl('delete')).toEqual([
        ['kubectl', '-n', 'kube-system', 'delete', 'secret', 'hcloud-csi', '--ignore-not-found'],
      ]);
    });

    it('hetzner: the delete goes alongside the reads, before the apply', async () => {
      holdLegacy(PROVIDERS.hetzner, TOKEN);
      await apply(PROVIDERS.hetzner);
      const applyAt = calls.findIndex(({ argv }) => argv[1] === 'apply');
      const deleteAt = calls.findIndex(({ argv }) => argv[3] === 'delete');
      expect(deleteAt).toBeGreaterThan(-1);
      expect(deleteAt).toBeLessThan(applyAt);
    });

    it('a failed delete warns with the command to run, and the deploy goes on', async () => {
      holdLegacy(PROVIDERS.hetzner, 'vc-sentinel-token-old');
      readerPerSecret(PROVIDERS.hetzner);
      failWhen = /^-n kube-system delete secret hcloud-csi /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl delete'), {
        status: 1,
        stderr: 'error: secrets "hcloud-csi" is forbidden\n',
      });
      await apply(PROVIDERS.hetzner);
      expect(logged).toContain(
        "Couldn't remove kube-system/hcloud-csi, an extra copy of your Hetzner Cloud API token " +
          'that nothing reads; the next deploy tries again. To remove it now, run ' +
          `\`KUBECONFIG='${KUBECONFIG}' kubectl -n kube-system delete secret hcloud-csi\`.\n` +
          'delete Secret kube-system/hcloud-csi failed with exit 1: ' +
          'error: secrets "hcloud-csi" is forbidden',
      );
      expect(cluster.get('kube-system/hcloud')).toEqual({ token: TOKEN });
      expect(restarts()).toHaveLength(1);
      expect(logged.join('\n')).not.toContain('vc-sentinel-token');
    });

    it('a failed key removal warns with the command to run, and the deploy goes on', async () => {
      holdLegacy(PROVIDERS.hetzner, 'vc-sentinel-token-old');
      readerPerSecret(PROVIDERS.hetzner);
      failWhen = /^-n kube-system patch secret hcloud /;
      kubectlFails = Object.assign(new Error('Command failed: kubectl patch'), {
        status: 1,
        stderr: 'error: secrets "hcloud" is forbidden\n',
      });
      await apply(PROVIDERS.hetzner);
      expect(logged).toContain(
        "Couldn't remove the network key from kube-system/hcloud, which nothing reads any more; " +
          'the next deploy tries again. To remove it now, run ' +
          `\`KUBECONFIG='${KUBECONFIG}' kubectl -n kube-system patch secret hcloud --type=merge ` +
          `-p '{"data":{"network":null}}'\`.\n` +
          'remove the network key from Secret kube-system/hcloud failed with exit 1: ' +
          'error: secrets "hcloud" is forbidden',
      );
      expect(cluster.get('kube-system/hcloud')?.token).toBe(TOKEN);
      expect(restarts()).toHaveLength(1);
      expect(logged.join('\n')).not.toContain('vc-sentinel-token');
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
        // A retired Secret's delete finds nothing and says nothing.
        const deletes = Provider.K8S_RETIRED_CLOUD_SECRETS.filter((r) => !r.keys).map(
          () => 'delete',
        );
        expect(verbs()).toEqual([...reads, ...deletes, 'apply']);
        expect(logged).toHaveLength(1);
      },
    );

    it('only the Secret that carries it', async () => {
      holdAll(TwoSecrets, TOKEN);
      lastApplied.set('kube-system/two', { token: TOKEN });
      await apply(TwoSecrets);
      expect(annotates().map((argv) => argv[5])).toEqual(['two']);
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
        await apply(Provider, 'vc-sentinel-token-new');
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
      expect(secretDataChanged(live, { token: TOKEN, network: NETWORK })).toBe(true);
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

describe('takesHostPorts', () => {
  const of = (spec: Record<string, unknown>) => ({ spec: { template: { spec } } });

  it('hostNetwork, or a hostPort on any container, init ones too', () => {
    expect(takesHostPorts(of({ hostNetwork: true }))).toBe(true);
    expect(
      takesHostPorts(of({ containers: [{ ports: [{ containerPort: 80, hostPort: 80 }] }] })),
    ).toBe(true);
    expect(
      takesHostPorts(of({ containers: [{}], initContainers: [{ ports: [{ hostPort: 9 }] }] })),
    ).toBe(true);
  });

  it('nothing else: a container port alone, hostPort 0, no ports, no template', () => {
    for (const spec of [
      {},
      { hostNetwork: false },
      { containers: [{ ports: [{ containerPort: 80 }] }] },
      { containers: [{ ports: [{ containerPort: 80, hostPort: 0 }] }] },
      { containers: [{}] },
    ]) {
      expect(takesHostPorts(of(spec)), JSON.stringify(spec)).toBe(false);
    }
    expect(takesHostPorts({})).toBe(false);
    expect(takesHostPorts(undefined as never)).toBe(false);
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
    expect(text).toContain(
      'applyCloudSecrets({ env: kubeEnv, ProviderClass: Provider, token: options.apiToken })',
    );
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
});
