/**
 * `vibecarbon destroy` still removes the servers when this project's state
 * passphrase cannot open the Pulumi state: missing, mismatched, too weak, or
 * a value Pulumi refuses. Destroy is the escape hatch the undecryptable-state
 * error points at, so it must not need the thing that is broken.
 *
 *   compose: the teardown is the provider API, and the stack record goes with
 *            `pulumi stack rm --force`, which reads nothing (Pulumi 3.259.0).
 *   k8s:     `pulumi destroy` cannot run, so the teardown falls to the API
 *            sweeps after it: every server labelled for the environment, and
 *            on a K8S_DESTROY_BACKSTOP provider the firewall, network, SSH key
 *            and reserved IP by name.
 *
 * Both say so in a warning. Driven through the destroy effect registry with
 * the real iac layer over a mocked LocalWorkspace, the real passphrase check
 * against a temp project, and a recording fake provider.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';
import { STATE_ERROR_CORPUS } from '../iac/fixtures/state-error-corpus.js';

const PASSPHRASE = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const OTHER_PASSPHRASE = 'b3RoZXJvdGhlcm90aGVyb3RoZXJvdGhlcm90aGVyb3Ro';

const warnings: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const noop = () => {};
  return {
    ...actual,
    log: {
      warn: (m: string) => warnings.push(m),
      error: noop,
      info: noop,
      success: noop,
      message: noop,
      step: noop,
    },
  };
});

// ── Pulumi: a workspace whose stack refuses the passphrase when told to ──
const pulumiCalls: string[] = [];
const workspaceEnvs: Record<string, string | undefined>[] = [];
let refusePassphrase = false;
const passphraseRefusal = () =>
  new Error(
    STATE_ERROR_CORPUS.find((c) => c.id === 'passphrase-incorrect-on-refresh')?.message ?? '',
  );
const fakeStack = (name: string) => {
  const op =
    (verb: string, result: () => unknown) =>
    async (...args: unknown[]) => {
      pulumiCalls.push(
        verb === 'removeStack' ? `${verb}:${args[0]}:${JSON.stringify(args[1])}` : verb,
      );
      if (refusePassphrase && verb !== 'removeStack' && verb !== 'cancel') {
        throw passphraseRefusal();
      }
      return result();
    };
  return {
    name,
    refresh: op('refresh', () => undefined),
    exportStack: op('exportStack', () => ({ deployment: { resources: [] } })),
    destroy: op('destroy', () => ({
      summary: { result: 'succeeded', resourceChanges: { delete: 3 } },
    })),
    outputs: op('outputs', () => ({})),
    cancel: op('cancel', () => undefined),
    workspace: { removeStack: op('removeStack', () => undefined) },
  };
};
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: async (
      args: { stackName: string },
      ws: { envVars: Record<string, string | undefined> },
    ) => {
      pulumiCalls.push(`select:${args.stackName}`);
      workspaceEnvs.push(ws.envVars);
      return fakeStack(args.stackName);
    },
    createStack: async () => {
      throw new Error('createStack must not be called by destroy');
    },
    create: async () => ({ listStacks: async () => [], whoAmI: async () => 'me' }),
  },
}));

// ── The cloud: a recording provider that owns one labelled server ──
const cloudCalls: string[] = [];
let backstop = true;
const LABELLED_SERVER = {
  id: 21,
  name: 'proj-e1-master',
  labels: { 'managed-by': 'vibecarbon', project: 'proj', environment: 'e1', role: 'master' },
};
const SPECIFIC: Record<string, (...args: unknown[]) => unknown> = {
  listServersDetailed: async () => ({ items: [LABELLED_SERVER], complete: true }),
  serverLabels: (sv: unknown) => (sv as { labels?: Record<string, string> }).labels ?? {},
  labelValue: (_k: unknown, v: unknown) => v,
  serverRegion: () => 'nbg1',
  serverNetworkIds: () => [],
  serverVolumeIds: () => [],
  deleteServer: async (id: unknown) => {
    cloudCalls.push(`deleteServer:${id}`);
    return true;
  },
  deleteFirewallByName: async (name: unknown) => {
    cloudCalls.push(`deleteFirewallByName:${name}`);
    return { deleted: true, apiError: null };
  },
  deleteSSHKeyByName: async (name: unknown) => {
    cloudCalls.push(`deleteSSHKeyByName:${name}`);
    return true;
  },
  deleteNetworkByName: async (name: unknown) => {
    cloudCalls.push(`deleteNetworkByName:${name}`);
    return { deleted: true, apiError: null };
  },
  deleteReservedIpsByLabels: async () => ({ deleted: [], failed: [] }),
};
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  function FakeProvider() {
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          if (prop === 'constructor') return FakeProvider;
          if (prop in SPECIFIC) return SPECIFIC[prop];
          if (prop === 'reservedIpLabelMatch') return undefined;
          if (/^(delete|remove|destroy|detach|release)/.test(prop)) {
            return async () => ({ deleted: true, everExisted: true, apiError: null });
          }
          if (/^(list|find|get)/.test(prop)) return async () => [];
          return () => undefined;
        },
      },
    );
  }
  Object.assign(FakeProvider, {
    NAME: 'Hetzner',
    getPublicIP: () => '203.0.113.1',
    promptObjectStorageCredentials: async () => ({ accessKey: 'AK', secretKey: 'SK' }),
  });
  Object.defineProperty(FakeProvider, 'K8S_DESTROY_BACKSTOP', { get: () => backstop });
  return { ...real, providerFor: () => FakeProvider };
});

const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
const { __resetStatePassphraseForTests, statePassphraseFingerprint } = await import(
  '../../../src/lib/state-passphrase.js'
);
const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');

const spinner = { start: () => {}, stop: () => {}, message: () => {} };
const S3 = {
  bucket: 'proj-storage',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  stateBucket: 'proj-state',
};

function makeCtx(tier: 'compose' | 'k8s', dir: string) {
  return {
    plan: {
      tier,
      stackEnvs: ['e1'],
      hasPulumiStack: tier === 'k8s',
      clusterNames: ['proj-e1'],
      ownedIps: ['203.0.113.1'],
    },
    envConfig: {
      provider: 'hetzner',
      deployMode: tier,
      region: 'nbg1',
      servers: [
        {
          role: 'master',
          name: 'master',
          ip: '203.0.113.1',
          id: tier === 'compose' ? 11 : 21,
          providerServerName: 'proj-e1',
        },
      ],
      s3: S3,
    },
    projectConfig: { projectName: 'proj' },
    environment: 'e1',
    providerToken: 'tok',
    results: {
      leaks: createLeakLedger(),
      servers: [] as string[],
      firewalls: [] as string[],
      sshKeys: [] as string[],
      dns: [] as string[],
      healthChecks: [] as string[],
      volumes: [] as string[],
      loadBalancers: [] as string[],
      pulumiDestroyFailed: false,
    },
    spinner,
    tracker: { spinner: () => spinner },
    cwd: dir,
  };
}

type Ctx = ReturnType<typeof makeCtx>;
const run = (effect: string, ctx: Ctx) =>
  (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>)[effect](ctx, {});

/** What the stack entry in the leak report says, if anything. */
const stackEntries = (ctx: Ctx) =>
  ctx.results.leaks.entries.filter(
    (e: { resourceClass: string }) => e.resourceClass === 'pulumi-stack',
  );

let dir: string;

/** A project whose .vibecarbon.json records PASSPHRASE's fingerprint. */
function project({ value }: { value?: string }) {
  dir = createTempDir('destroy-passphrase-');
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    `${JSON.stringify({ stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) } })}\n`,
  );
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  if (value === undefined) {
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', undefined);
    delete process.env.VIBECARBON_STATE_PASSPHRASE;
  } else {
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', value);
  }
}

beforeEach(() => {
  warnings.length = 0;
  pulumiCalls.length = 0;
  workspaceEnvs.length = 0;
  cloudCalls.length = 0;
  refusePassphrase = false;
  backstop = true;
  __resetStatePassphraseForTests();
  vi.stubEnv('HETZNER_ACCESS_KEY', 'AK');
  vi.stubEnv('HETZNER_SECRET_KEY', 'SK');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('compose: provider API plus `stack rm --force`, whatever the passphrase', () => {
  it.each([
    ['missing', undefined, "VIBECARBON_STATE_PASSPHRASE isn't set"],
    ['mismatched', OTHER_PASSPHRASE, "doesn't match"],
  ])(
    'passphrase %s: the server goes, the stack record goes, and a warning says why it could',
    async (_label, value, why) => {
      project({ value });
      const ctx = makeCtx('compose', dir);

      await run('destroyComposeServices', ctx);
      await run('removePulumiStackState', ctx);

      expect(cloudCalls).toContain('deleteServer:11');
      expect(cloudCalls).toContain('deleteFirewallByName:proj-e1-firewall');
      expect(pulumiCalls).toContain('removeStack:e1:{"force":true}');
      // Nothing decrypting ran, and the workspace saw only the operator's own
      // value or none: never an invented or empty one. (`stack rm --force`
      // works under a wrong passphrase, so a mismatched value is harmless.)
      expect(pulumiCalls.filter((c) => /^(refresh|destroy|exportStack|outputs)$/.test(c))).toEqual(
        [],
      );
      expect(workspaceEnvs.length).toBeGreaterThan(0);
      for (const env of workspaceEnvs)
        expect([undefined, value]).toContain(env.PULUMI_CONFIG_PASSPHRASE);
      expect(ctx.results.leaks.isClean()).toBe(true);

      const warning = warnings.join('\n');
      expect(warning).toContain("can't read the Pulumi state for e1");
      expect(warning).toContain(why);
      expect(warning).toContain('Hetzner API');
      expect(warning).not.toContain('—');

      // Destroy never makes a passphrase of its own.
      expect(existsSync(join(dir, '.env.local'))).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf8'))).toEqual({
        stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) },
      });
    },
  );

  it('a healthy passphrase destroys exactly as before, with no warning', async () => {
    project({ value: PASSPHRASE });
    const ctx = makeCtx('compose', dir);

    await run('destroyComposeServices', ctx);
    await run('removePulumiStackState', ctx);

    expect(pulumiCalls).toContain('removeStack:e1:{"force":true}');
    expect(warnings.join('\n')).not.toContain('Pulumi state');
  });
});

describe('k8s: the API sweeps still run when Pulumi cannot read the state', () => {
  it('passphrase missing: servers and the backstop resources go, the stack is kept as UNVERIFIED with a way back', async () => {
    project({ value: undefined });
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    // The check refused before Pulumi was ever asked.
    expect(pulumiCalls).toEqual([]);
    // The server sweep and the by-name backstop ran.
    expect(cloudCalls).toContain('deleteServer:21');
    expect(cloudCalls).toContain('deleteFirewallByName:proj-e1-firewall');
    expect(cloudCalls).toContain('deleteNetworkByName:proj-e1-network');

    const [entry, ...rest] = stackEntries(ctx);
    expect(rest).toEqual([]);
    expect(entry.severity).toBe('unverified');
    expect(entry.resource).toBe('e1');
    expect(entry.reason).toContain("VIBECARBON_STATE_PASSPHRASE isn't set");
    expect(entry.hint).toContain('VIBECARBON_STATE_PASSPHRASE back in .env.local');
    expect(entry.hint).toContain('`vibecarbon destroy e1`');
    // The env entry and the stack record are kept for the run that can read it.
    expect(ctx.results.pulumiDestroyFailed).toBe(true);

    const warning = warnings.join('\n');
    expect(warning).toContain("can't read the Pulumi state for e1");
    expect(warning).toContain('Hetzner API');
    expect(warning).not.toContain('—');
  });

  it('Pulumi refuses the passphrase: no retry, no destroy, servers still swept, leftovers named for the console', async () => {
    project({ value: PASSPHRASE });
    refusePassphrase = true;
    backstop = false;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    // One refresh, refused; the destroy itself never ran, nothing was removed.
    expect(pulumiCalls).toEqual(['select:e1', 'refresh']);
    expect(cloudCalls).toContain('deleteServer:21');
    // No by-name backstop on this provider.
    expect(cloudCalls.some((c) => c.startsWith('deleteNetworkByName'))).toBe(false);

    const [entry, ...rest] = stackEntries(ctx);
    expect(rest).toEqual([]);
    expect(entry.severity).toBe('unverified');
    expect(entry.reason).toContain("this project's passphrase doesn't decrypt it");
    expect(entry.hint).toContain('Hetzner console');
    expect(entry.hint).toContain('proj-e1');
    expect(ctx.results.pulumiDestroyFailed).toBe(true);

    expect(warnings.join('\n')).toContain("can't read the Pulumi state for e1");
  });
});
