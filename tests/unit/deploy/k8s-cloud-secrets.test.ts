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
 *     refuses before kubectl runs;
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
let kubectlFails: Error | null = null;

vi.mock('../../../src/lib/command.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../src/lib/command.js');
  return {
    ...actual,
    runCommandAsync: vi.fn(async (argv: string[], opts: { input?: string; env?: never }) => {
      calls.push({ argv, input: opts?.input, env: opts?.env });
      if (kubectlFails) throw kubectlFails;
      return '';
    }),
  };
});

const { applyCloudSecrets, CLOUD_SECRETS_APPLY_ARGV } = await import(
  '../../../src/lib/deploy/k8s/k3s.js'
);
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
      ...values,
    });

  it.each(K8S_PROVIDERS)(
    '%s: one server-side apply, owned by the CLI, every Secret on stdin',
    async (_id, Provider) => {
      await apply(Provider);
      expect(calls).toHaveLength(1);
      const [{ argv, input, env }] = calls;
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
      await apply(Provider);
      const [{ argv, input }] = calls;
      expect(String(input)).toContain(MARK);
      expect(argv.join(' ')).not.toContain(MARK);
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

  it.each(K8S_PROVIDERS)('%s: no token, no apply', async (_id, Provider) => {
    const [{ namespace, name, stringData }] = Provider.k8sCloudSecrets({ token: TOKEN });
    const key = Object.keys(stringData).find((k) => stringData[k] === TOKEN);
    for (const token of ['', undefined]) {
      await expect(apply(Provider, { token, networkId: NETWORK } as never)).rejects.toThrow(
        `Can't hand your ${Provider.NAME} API token to the cluster: this deploy has no ${key} for Secret ${namespace}/${name}.`,
      );
    }
    expect(calls).toHaveLength(0);
    expect(logged).toEqual([]);
  });

  it("Hetzner without the cluster's network id refuses before kubectl runs", async () => {
    await expect(
      apply(PROVIDERS.hetzner, { token: TOKEN, networkId: undefined } as never),
    ).rejects.toThrow(
      "Can't hand your Hetzner Cloud API token to the cluster: this deploy has no network for Secret kube-system/hcloud.",
    );
    expect(calls).toHaveLength(0);
  });

  it.each(OTHER_PROVIDERS)('%s: nothing to hand over, nothing runs', async (_id, Provider) => {
    await apply(Provider);
    expect(calls).toHaveLength(0);
    expect(logged).toEqual([]);
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
