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
 *            and reserved IP by name. The record then goes too when it holds
 *            nothing usable: always when Pulumi itself refused the
 *            passphrase, and for a passphrase refused before Pulumi ran only
 *            when the by-name sweeps covered the stack and left nothing.
 *
 * Both say so in a warning. Driven through the destroy effect registry with
 * the real iac layer over the shared fake Pulumi workspace, the real
 * passphrase check against a temp project, and a recording fake provider.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePulumi } from '../../_shared/fake-pulumi-workspace.js';
import { createTempDir } from '../../_shared/temp-dir.js';
import { STATE_ERROR_CORPUS } from '../iac/fixtures/state-error-corpus.js';

const PASSPHRASE = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const OTHER_PASSPHRASE = 'b3RoZXJvdGhlcm90aGVyb3RoZXJvdGhlcm90aGVyb3Ro';

const warnings: string[] = [];
const infos: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const noop = () => {};
  return {
    ...actual,
    log: {
      warn: (m: string) => warnings.push(m),
      error: noop,
      info: (m: string) => infos.push(m),
      success: noop,
      message: noop,
      step: noop,
    },
  };
});

vi.mock('@pulumi/pulumi/automation/index.js', async () =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
);
// The one-time legacy migration's child (`pulumi stack change-secrets-provider`).
vi.mock('node:child_process', async (orig) =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeChildProcessModule(
    await orig<typeof import('node:child_process')>(),
  ),
);

const passphraseRefusal = () =>
  new Error(
    STATE_ERROR_CORPUS.find((c) => c.id === 'passphrase-incorrect-on-refresh')?.message ?? '',
  );

// A live cluster answers the PersistentVolume capture; nothing to collect.
vi.mock('../../../src/lib/csi-volumes.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  captureClusterCsiVolumes: () => ({
    ok: true,
    volumes: [],
    volumeIds: [],
    regions: [],
    skippedDrivers: [],
  }),
}));

// ── The cloud: a recording provider that owns one labelled server ──
const cloudCalls: string[] = [];
let backstop = true;
let firewallDeleteFails = false;
/**
 * How the server listing answers: whole, or cut short (a soft-failed page)
 * after finding nothing or after finding the labelled server.
 */
let serverListing: 'complete' | 'incomplete-empty' | 'incomplete-found' = 'complete';
const LABELLED_SERVER = {
  id: 21,
  name: 'proj-e1-master',
  labels: { 'managed-by': 'vibecarbon', project: 'proj', environment: 'e1', role: 'master' },
};
const SPECIFIC: Record<string, (...args: unknown[]) => unknown> = {
  listServersDetailed: async () => ({
    items: serverListing === 'incomplete-empty' ? [] : [LABELLED_SERVER],
    complete: serverListing === 'complete',
  }),
  listVolumesDetailed: async () => ({ items: [], complete: true }),
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
    return firewallDeleteFails
      ? { deleted: false, apiError: new Error('firewall is in use') }
      : { deleted: true, apiError: null };
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
const { DESTROY_EFFECTS, passphraseRecoveryHint, settleUnreadableStacks } = await import(
  '../../../src/destroy.js'
);
const { __resetStateProbesForTests } = await import('../../../src/lib/iac/index.js');

const spinner = { start: () => {}, stop: () => {}, message: () => {} };
const S3 = {
  bucket: 'proj-storage',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  stateBucket: 'proj-state',
};
const REMOVE = (stackEnv: string) => `removeStack:${stackEnv}:{"force":true}`;

function makeCtx(tier: 'compose' | 'k8s' | 'k8s-ha', dir: string) {
  const stackEnvs = tier === 'k8s-ha' ? ['e1-primary', 'e1-standby'] : ['e1'];
  return {
    plan: {
      tier,
      stackEnvs,
      hasPulumiStack: tier !== 'compose',
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
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

/** What the stack entries in the leak report say, if anything. */
const stackEntries = (ctx: Ctx) =>
  ctx.results.leaks.entries.filter(
    (e: { resourceClass: string }) => e.resourceClass === 'pulumi-stack',
  );
const removals = () => fakePulumi.calls.filter((c) => c.startsWith('removeStack:'));

let dir: string;

/**
 * A project whose .vibecarbon.json records PASSPHRASE's fingerprint, or
 * nothing at all (`recorded: false`: a clone that never had it).
 */
function project({ value, recorded = true }: { value?: string; recorded?: boolean }) {
  dir = createTempDir('destroy-passphrase-');
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    `${JSON.stringify(recorded ? { stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) } } : {})}\n`,
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
  infos.length = 0;
  fakePulumi.reset();
  fakePulumi.removed = null;
  cloudCalls.length = 0;
  backstop = true;
  firewallDeleteFails = false;
  serverListing = 'complete';
  __resetStatePassphraseForTests();
  __resetStateProbesForTests();
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
      expect(fakePulumi.calls).toContain(REMOVE('e1'));
      // Nothing decrypting ran, and the workspace saw only the operator's own
      // value or none: never an invented or empty one. (`stack rm --force`
      // works under a wrong passphrase, so a mismatched value is harmless.)
      expect(
        fakePulumi.calls.filter((c) => /^(refresh|destroy|exportStack|outputs)$/.test(c)),
      ).toEqual([]);
      expect(fakePulumi.workspaceEnvs.length).toBeGreaterThan(0);
      for (const env of fakePulumi.workspaceEnvs)
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

    expect(fakePulumi.calls).toContain(REMOVE('e1'));
    expect(warnings.join('\n')).not.toContain('Pulumi state');
  });
});

describe('k8s, refused before Pulumi ran: the record goes only when the backstop covered everything', () => {
  it('backstop sweeps left nothing: servers and by-name resources go, and so does the record', async () => {
    project({ value: undefined });
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    // The check refused before Pulumi was asked to read anything; the record
    // was removed without being read.
    expect(fakePulumi.calls).toEqual(['select:e1', REMOVE('e1')]);
    expect(cloudCalls).toContain('deleteServer:21');
    expect(cloudCalls).toContain('deleteFirewallByName:proj-e1-firewall');
    expect(cloudCalls).toContain('deleteNetworkByName:proj-e1-network');
    // Nothing left: no stack line, the environment entry goes as on any
    // destroy, and the exit code says clean.
    expect(stackEntries(ctx)).toEqual([]);
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
    expect(ctx.results.leaks.exitCode()).toBe(0);

    const warning = warnings.join('\n');
    expect(warning).toContain("can't read the Pulumi state for e1");
    expect(warning).toContain('Hetzner API');
    expect(warning).not.toContain('—');
  });

  it('a backstop sweep left something: the record is kept, with how to put the value back', async () => {
    project({ value: undefined });
    firewallDeleteFails = true;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(removals()).toEqual([]);
    expect(cloudCalls).toContain('deleteServer:21');
    const [entry, ...rest] = stackEntries(ctx);
    expect(rest).toEqual([]);
    expect(entry.severity).toBe('unverified');
    expect(entry.resource).toBe('e1');
    expect(entry.reason).toContain("VIBECARBON_STATE_PASSPHRASE isn't set");
    expect(entry.reason).toContain('stack record was kept');
    expect(entry.hint).toContain(
      "Copy this project's VIBECARBON_STATE_PASSPHRASE into .env.local from where you saved it, then run `vibecarbon destroy e1` again",
    );
    expect(entry.hint).toContain(
      "If it's lost for good, delete the `stateEncryption` entry from .vibecarbon.json, then run `vibecarbon destroy e1` again",
    );
    expect(entry.hint).not.toContain('—');
    // Kept for the retry that can read it.
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
  });

  it('a cut-short server listing that found a server: deleted, and the scan still reads unverified, so the record is kept', async () => {
    project({ value: undefined });
    serverListing = 'incomplete-found';
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    // What the listing found goes; what it never read can't be ruled out,
    // so the ledger is not clean and the record stays for the retry.
    expect(cloudCalls).toContain('deleteServer:21');
    expect(ctx.results.leaks.entries).toContainEqual(
      expect.objectContaining({
        resourceClass: 'server',
        severity: 'unverified',
        resource: 'orphaned-server scan: proj-e1',
      }),
    );
    expect(removals()).toEqual([]);
    const [entry, ...rest] = stackEntries(ctx);
    expect(rest).toEqual([]);
    expect(entry.reason).toContain('stack record was kept');
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
  });

  it('no backstop: the record is kept, whatever the sweeps did', async () => {
    project({ value: OTHER_PASSPHRASE });
    backstop = false;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(fakePulumi.calls).toEqual([]);
    expect(cloudCalls).toContain('deleteServer:21');
    expect(cloudCalls.some((c) => c.startsWith('deleteNetworkByName'))).toBe(false);
    const [entry] = stackEntries(ctx);
    expect(entry.reason).toContain("doesn't match the fingerprint");
    // Set in the test's environment, which a shell export stands for.
    expect(entry.hint).toContain('in your shell environment wins over .env.local');
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
  });
});

describe('k8s, Pulumi refused the passphrase: the record goes on every provider', () => {
  it("no backstop: the open's reads refused, servers swept, record removed, leftovers named for the console", async () => {
    project({ value: PASSPHRASE });
    fakePulumi.refuseReads(passphraseRefusal);
    backstop = false;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    // The open's read, refused; the empty passphrase of a legacy stack,
    // refused too; and one more read in case another run re-encrypted it in
    // between, still refused. No refresh, no destroy, no retry. Then the
    // record goes without being read.
    expect(fakePulumi.calls).toEqual([
      'select:e1',
      'exportStack',
      'migrate:e1',
      'exportStack',
      'select:e1',
      REMOVE('e1'),
    ]);
    expect(cloudCalls).toContain('deleteServer:21');
    expect(cloudCalls.some((c) => c.startsWith('deleteNetworkByName'))).toBe(false);

    const [entry, ...rest] = stackEntries(ctx);
    expect(rest).toEqual([]);
    expect(entry.severity).toBe('unverified');
    expect(entry.reason).toContain("this project's passphrase doesn't decrypt it");
    expect(entry.reason).toContain('record was removed without being read');
    expect(entry.hint).toContain('Hetzner console');
    expect(entry.hint).toContain('their names start with proj-e1');
    // No record left to retry against, so no retry is promised.
    expect(entry.hint).not.toContain('vibecarbon destroy');
    // The environment entry goes; the exit code still says something may be left.
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
    expect(ctx.results.leaks.exitCode()).not.toBe(0);

    // Pulumi's own line is logged once for diagnosis; the passphrase never is.
    const logged = [...infos, ...warnings].join('\n');
    expect(logged.match(/refused the state passphrase/g)).toHaveLength(1);
    expect(logged).toContain('failed to decrypt: incorrect passphrase');
    expect(logged).not.toContain(PASSPHRASE);
  });

  it('backstop sweeps left nothing: the record goes and the destroy is clean', async () => {
    project({ value: PASSPHRASE });
    fakePulumi.refuseReads(passphraseRefusal);
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(removals()).toEqual([REMOVE('e1')]);
    expect(cloudCalls).toContain('deleteFirewallByName:proj-e1-firewall');
    expect(stackEntries(ctx)).toEqual([]);
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
    expect(ctx.results.leaks.exitCode()).toBe(0);
  });

  it('backstop sweeps left something: the record still goes, and the line points at the report', async () => {
    project({ value: PASSPHRASE });
    fakePulumi.refuseReads(passphraseRefusal);
    firewallDeleteFails = true;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(removals()).toEqual([REMOVE('e1')]);
    const [entry] = stackEntries(ctx);
    expect(entry.hint).toContain('listed in this report');
    // The sweeps alone removed this stack's servers and left something: the
    // environment entry stays so a destroy retry runs them again.
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
    expect(ctx.results.leaks.exitCode()).not.toBe(0);
  });

  it('the server sweep could not finish: the record still goes, the environment entry stays for the retry', async () => {
    project({ value: PASSPHRASE });
    fakePulumi.trackRemovals();
    fakePulumi.refuseReads(passphraseRefusal);
    backstop = false;
    serverListing = 'incomplete-empty';
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(removals()).toEqual([REMOVE('e1')]);
    expect(
      ctx.results.leaks.entries.some(
        (e: { resourceClass: string; severity: string }) =>
          e.resourceClass === 'server' && e.severity === 'unverified',
      ),
    ).toBe(true);
    expect(ctx.results.pulumiDestroyFailed).toBe(true);

    // The retry: the record is gone, so destroy finds no stack (a no-op, not
    // a failure) and the sweeps run again. This time they finish, and
    // nothing keeps the environment entry any more.
    fakePulumi.calls.length = 0;
    serverListing = 'complete';
    const retry = makeCtx('k8s', dir);
    await run('destroyK8sInfra', retry);
    expect(fakePulumi.calls).toContain('select:e1');
    expect(removals()).toEqual([]);
    expect(stackEntries(retry)).toEqual([]);
    expect(retry.results.pulumiDestroyFailed).toBe(false);
  });
});

describe('k8s, Pulumi refused a passphrase this run made: the real one may exist elsewhere', () => {
  it('no backstop: the record is kept, with how to bring the project passphrase in, and the next run removes it', async () => {
    project({ value: undefined, recorded: false });
    fakePulumi.refuseReads(passphraseRefusal);
    backstop = false;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    // This run made the passphrase (no value, no fingerprint), Pulumi
    // refused it, and the record stays.
    expect(existsSync(join(dir, '.env.local'))).toBe(true);
    expect(removals()).toEqual([]);
    expect(cloudCalls).toContain('deleteServer:21');
    const [entry, ...rest] = stackEntries(ctx);
    expect(rest).toEqual([]);
    expect(entry.reason).toContain("the passphrase this run made doesn't decrypt it");
    expect(entry.hint).toContain(
      "If the project has one, pull the latest .vibecarbon.json (dropping the `stateEncryption` entry this run wrote) and copy the project's VIBECARBON_STATE_PASSPHRASE into .env.local in place of the new one, then run `vibecarbon destroy e1` again.",
    );
    expect(entry.hint).toContain(
      "If it's lost for good, run `vibecarbon destroy e1` again as it is: that run removes the record.",
    );
    expect(entry.hint).not.toContain('—');
    expect(ctx.results.pulumiDestroyFailed).toBe(true);

    // The next run, as it is: a new process with the passphrase this run
    // saved, which is no longer new. Pulumi refuses it again, and the record goes.
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    fakePulumi.reset();
    fakePulumi.refuseReads(passphraseRefusal);
    const again = makeCtx('k8s', dir);
    await run('destroyK8sInfra', again);
    expect(removals()).toEqual([REMOVE('e1')]);
  });

  it('backstop sweeps left nothing: the record goes, as for any recoverable refusal', async () => {
    project({ value: undefined, recorded: false });
    fakePulumi.refuseReads(passphraseRefusal);
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(removals()).toEqual([REMOVE('e1')]);
    expect(stackEntries(ctx)).toEqual([]);
  });
});

describe('k8s, a legacy stack (written with the empty passphrase): migrated, then destroyed by Pulumi', () => {
  it.each([
    ['the project passphrase', { value: PASSPHRASE }],
    ['a passphrase this run made', { value: undefined, recorded: false }],
  ])(
    'with %s: re-encrypted on the open, `pulumi destroy` runs, and the unreadable path never sees it',
    async (_label, setup) => {
      project(setup);
      fakePulumi.legacy('e1', passphraseRefusal);
      // Once it reads, it holds the cluster's master.
      fakePulumi.behaviour.exportStack = () => ({
        deployment: {
          resources: [
            { type: 'pulumi:pulumi:Stack' },
            { type: 'hcloud:index/server:Server', id: '21', outputs: { name: 'proj-e1-master' } },
          ],
        },
      });
      backstop = false;
      const ctx = makeCtx('k8s', dir);

      await run('destroyK8sInfra', ctx);

      // Read, re-encrypted, read again; then the refresh, the destroy and
      // Pulumi's own removal of the destroyed stack (no `--force`).
      expect(fakePulumi.calls).toEqual([
        'select:e1',
        'exportStack',
        'migrate:e1',
        'exportStack',
        'refresh',
        'exportStack',
        'destroy',
        'removeStack:e1:undefined',
      ]);
      expect(removals()).toEqual(['removeStack:e1:undefined']);
      expect(infos).toContain(
        "Your Pulumi state for e1 was stored with an empty passphrase. vibecarbon re-encrypted it with this project's passphrase.",
      );
      expect(warnings.join('\n')).not.toContain("can't read the Pulumi state");
      expect(stackEntries(ctx)).toEqual([]);
      expect(ctx.results.pulumiDestroyFailed).toBe(false);
    },
  );
});

describe('k8s, a legacy stack behind a lock: the migration takes the lock, and the record is never ruled unreadable', () => {
  /** CLI 3.259.0's refusal when `change-secrets-provider` meets a held lock. */
  const lockRefusal = (holder: { host: string; pid: number; at: string }) =>
    'error: the stack is currently locked by 1 lock(s). Either wait for the other process(es) ' +
    'to end or delete the lock file with `pulumi cancel`.\n' +
    `  s3://proj-state/.pulumi/locks/organization/proj/e1/0b1c2d3e.json: created by someone@${holder.host} (pid ${holder.pid}) at ${holder.at}\n`;

  /** A legacy stack whose first migration meets `holder`'s lock. */
  function legacyBehindLock(holder: { host: string; pid: number; at: string }) {
    fakePulumi.legacy('e1', passphraseRefusal);
    fakePulumi.behaviour.exportStack = () => ({
      deployment: {
        resources: [
          { type: 'pulumi:pulumi:Stack' },
          { type: 'hcloud:index/server:Server', id: '21', outputs: { name: 'proj-e1-master' } },
        ],
      },
    });
    let runs = 0;
    fakePulumi.behaviour.migrate = (name) => {
      runs += 1;
      if (runs === 1) return { code: 1, stderr: lockRefusal(holder) };
      fakePulumi.legacyStacks.delete(name);
      return { code: 0 };
    };
  }

  it('a lock a dead run left: cleared, re-encrypted, and `pulumi destroy` removes the stack itself', async () => {
    project({ value: PASSPHRASE });
    // Past the two-hour expiry.
    legacyBehindLock({ host: 'ci-runner-long-gone', pid: 4321, at: '2026-01-01T00:00:00Z' });
    backstop = false;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(fakePulumi.calls).toEqual([
      'select:e1',
      'exportStack',
      'migrate:e1',
      'cancel',
      'migrate:e1',
      'exportStack',
      'refresh',
      'exportStack',
      'destroy',
      'removeStack:e1:undefined',
    ]);
    // Pulumi's own removal of a destroyed stack, never the unread `--force` one.
    expect(removals()).toEqual(['removeStack:e1:undefined']);
    expect(warnings.join('\n')).not.toContain("can't read the Pulumi state");
    expect(stackEntries(ctx)).toEqual([]);
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
  });

  it('a lock a live run holds: the destroy stops for this stack, and its record stays', async () => {
    project({ value: PASSPHRASE });
    legacyBehindLock({ host: hostname(), pid: process.pid, at: new Date().toISOString() });
    backstop = false;
    const ctx = makeCtx('k8s', dir);

    await run('destroyK8sInfra', ctx);

    expect(fakePulumi.calls.slice(0, 3)).toEqual(['select:e1', 'exportStack', 'migrate:e1']);
    expect(fakePulumi.calls).not.toContain('cancel');
    expect(fakePulumi.calls).not.toContain('destroy');
    expect(removals()).toEqual([]);
    expect(warnings.join('\n')).not.toContain("can't read the Pulumi state");
    expect(ctx.results.pulumiDestroyFailed).toBe(true);
    const [entry, ...rest] = stackEntries(ctx);
    expect(rest).toEqual([]);
    expect(entry.reason).toContain('Stack "e1" is in use by another run');
    expect(entry.hint).toContain('Pulumi state was preserved for this stack');
  });
});

describe('k8s-ha: each stack of the pair is settled, under its own name', () => {
  it('Pulumi refused both: both records go, each leftover line names its own stack', async () => {
    project({ value: PASSPHRASE });
    fakePulumi.refuseReads(passphraseRefusal);
    backstop = false;
    const ctx = makeCtx('k8s-ha', dir);

    await run('destroyK8sInfra', ctx);

    expect(removals().sort()).toEqual([REMOVE('e1-primary'), REMOVE('e1-standby')]);
    const entries = stackEntries(ctx);
    expect(entries.map((e: { resource: string }) => e.resource).sort()).toEqual([
      'e1-primary (e1-primary)',
      'e1-standby (e1-standby)',
    ]);
    for (const e of entries) {
      const stackEnv = e.resource.split(' ')[0];
      expect(e.hint).toContain(`their names start with proj-${stackEnv}`);
    }
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
  });

  it('refused before Pulumi ran, backstop clean: both records go, judged against the same sweeps', async () => {
    project({ value: undefined });
    const ctx = makeCtx('k8s-ha', dir);

    await run('destroyK8sInfra', ctx);

    expect(removals().sort()).toEqual([REMOVE('e1-primary'), REMOVE('e1-standby')]);
    expect(cloudCalls).toContain('deleteSSHKeyByName:proj-e1-ha-key');
    expect(stackEntries(ctx)).toEqual([]);
    expect(ctx.results.pulumiDestroyFailed).toBe(false);
  });
});

describe('the way back names what to fix, for each reason and each store', () => {
  const KEY = 'VIBECARBON_STATE_PASSPHRASE';
  const LOST =
    ", and once more if it asks: this state can't be read without the old passphrase, so destroy removes the record.";
  it.each([
    [
      'missing',
      undefined,
      `Copy this project's ${KEY} into .env.local from where you saved it, then run \`vibecarbon destroy e1\` again`,
      "If it's lost for good, delete the `stateEncryption` entry from .vibecarbon.json, then run `vibecarbon destroy e1` again",
    ],
    [
      'mismatch',
      'shell',
      `The ${KEY} in your shell environment wins over .env.local and isn't this project's. Unset it so vibecarbon reads .env.local, or set it to this project's value`,
      `If it's lost for good, unset ${KEY} in your shell and delete the \`stateEncryption\` entry from .vibecarbon.json, then`,
    ],
    [
      'mismatch',
      'env-local',
      `The ${KEY} in .env.local isn't this project's. Replace it with the value you saved for this project`,
      "If it's lost for good, delete the `stateEncryption` entry from .vibecarbon.json, then",
    ],
    [
      'invalid',
      'shell',
      `The ${KEY} in your shell environment is too weak to be this project's. Unset it so vibecarbon reads .env.local`,
      `If it's lost for good, unset ${KEY} in your shell and delete the \`stateEncryption\` entry from .vibecarbon.json, then`,
    ],
    [
      'invalid',
      'env-local',
      `The ${KEY} in .env.local is too weak to be this project's. Replace it with the value you saved for this project`,
      `If it's lost for good, delete the ${KEY} line from .env.local and the \`stateEncryption\` entry from .vibecarbon.json, then`,
    ],
  ])('%s from %s', (reason, source, fix, lost) => {
    const hint = passphraseRecoveryHint({ reason, source }, 'e1');
    expect(hint).toContain(fix);
    expect(hint).toContain(lost);
    expect(hint.endsWith(LOST)).toBe(true);
    expect(hint).toContain('Pulumi then removes whatever is left of this stack');
    // A file fix is never offered for a value the shell overrides, and the
    // reverse.
    if (source === 'shell') expect(hint).not.toContain('Replace it');
    if (source === 'env-local') expect(hint).not.toContain('shell');
    expect(hint).not.toContain('—');
  });
});

describe('settleUnreadableStacks: a record it cannot remove is kept for the retry', () => {
  const settle = (over: Record<string, unknown>) => {
    const results = { leaks: createLeakLedger(), pulumiDestroyFailed: false };
    const removed: string[] = [];
    const done = settleUnreadableStacks({
      stacks: [{ stackEnv: 'e1', dirLabel: '', error: passphraseRefusal() }],
      environment: 'e1',
      projectName: 'proj',
      results,
      providerName: 'DigitalOcean',
      backstop: true,
      backendResolved: true,
      removeRecord: async (stackEnv: string) => {
        removed.push(stackEnv);
      },
      s: spinner,
      ...over,
    });
    return { results, removed, done };
  };

  it('state-backend credentials unresolved: nothing is removed against the local fallback', async () => {
    const { results, removed, done } = settle({ backendResolved: false });
    await done;
    expect(removed).toEqual([]);
    expect(results.pulumiDestroyFailed).toBe(true);
    const [entry] = results.leaks.entries;
    expect(entry.reason).toContain('stack record was kept');
    expect(entry.hint).toContain("object-storage credentials couldn't be resolved");
  });

  const missing = () =>
    Object.assign(new Error("This project's state passphrase isn't set."), {
      name: 'StatePassphraseError',
      reason: 'missing',
    });

  it('a precheck failure with unresolved credentials: both ways back are named', async () => {
    const { results, removed, done } = settle({
      backendResolved: false,
      stacks: [{ stackEnv: 'e1', dirLabel: '', error: missing() }],
    });
    await done;
    expect(removed).toEqual([]);
    const [entry] = results.leaks.entries;
    expect(entry.hint).toContain("Copy this project's VIBECARBON_STATE_PASSPHRASE into .env.local");
    expect(entry.hint).toContain("object-storage credentials couldn't be resolved");
  });

  it('a precheck failure inside a wrapper is still recoverable: kept, not removed', async () => {
    const wrapped = new Error('could not open stack e1', { cause: missing() });
    const { results, removed, done } = settle({
      backstop: false,
      stacks: [{ stackEnv: 'e1', dirLabel: '', error: wrapped }],
    });
    await done;
    expect(removed).toEqual([]);
    expect(results.pulumiDestroyFailed).toBe(true);
    const [entry] = results.leaks.entries;
    expect(entry.reason).toContain("VIBECARBON_STATE_PASSPHRASE isn't set");
    expect(entry.hint).toContain("Copy this project's VIBECARBON_STATE_PASSPHRASE into .env.local");
  });

  it("a pair is judged against the sweeps, not against the first stack's own line", async () => {
    const precheck = Object.assign(new Error("This project's state passphrase isn't set."), {
      name: 'StatePassphraseError',
      reason: 'missing',
    });
    const removed: string[] = [];
    const results = { leaks: createLeakLedger(), pulumiDestroyFailed: false };
    await settleUnreadableStacks({
      stacks: [
        { stackEnv: 'e1-primary', dirLabel: ' (e1-primary)', error: precheck },
        { stackEnv: 'e1-standby', dirLabel: ' (e1-standby)', error: precheck },
      ],
      environment: 'e1',
      projectName: 'proj',
      results,
      providerName: 'DigitalOcean',
      backstop: true,
      backendResolved: true,
      removeRecord: async (stackEnv: string) => {
        if (stackEnv === 'e1-primary') throw new Error('SlowDown');
        removed.push(stackEnv);
      },
      s: spinner,
    });
    // The primary's failed removal is its own line; the standby's sweeps were
    // clean, so its record still goes.
    expect(removed).toEqual(['e1-standby']);
    expect(results.leaks.entries.map((e: { resource: string }) => e.resource)).toEqual([
      'e1-primary (e1-primary)',
    ]);
  });

  it('the removal fails: kept, with the error, and the retry named', async () => {
    const { results, done } = settle({
      removeRecord: async () => {
        throw new Error('SlowDown: please reduce your request rate');
      },
    });
    await done;
    expect(results.pulumiDestroyFailed).toBe(true);
    const [entry] = results.leaks.entries;
    expect(entry.reason).toContain('removing its stack record failed: SlowDown');
    expect(entry.hint).toContain('`vibecarbon destroy e1` again');
  });
});
