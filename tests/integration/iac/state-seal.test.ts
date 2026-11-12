/**
 * The seal after an up, on the real Pulumi engine: a file:// backend in a tmp
 * dir and the fake cloud's resource plugin (fakecloud/), whose Server is a
 * server class here (SERVER_RESOURCE_TYPES, with fakecloud:index:Server
 * added), so upStack seals it as it seals a provider's.
 *
 * A stack written before the programs wrapped user data in pulumi.secret
 * keeps it plain: user data is in ignoreChanges, so an up of the wrapped
 * program is a `same` step and the engine keeps what the state holds. The
 * stack is also a legacy one with no secret at all, written with the empty
 * passphrase older versions used: it still carries that passphrase's salt,
 * and Pulumi refuses to import a secret into it (R20). Pinned here:
 *   (control) sealed before the up, that import is refused, and the
 *       checkpoint still holds the plain user data;
 *   (a) upStack's seal runs after the up, which re-salts the stack, so the
 *       import goes through. The sealed values open to the user data they
 *       held. The legacy user data sentinel is gone from every file in the
 *       backend: the stack's checkpoint, the .bak Pulumi keeps beside it, and
 *       each history copy that held it, while every `.history.json` stays.
 *       The ledger gets the seal marker, and the servers are untouched;
 *   (b) a second deploy (refresh, then up) hands the sealed values back
 *       sealed: it seals 0, reads no history (the marker is set), and the
 *       server is still not replaced;
 *   (c) no import leaves its deployment file behind;
 *   (d) a legacy stack that also records a server create an earlier run
 *       didn't finish, its user data plain: the provider (a fake) lists no
 *       server by that name, so the deploy clears the record with the SDK's
 *       refresh({ clearPendingCreates: true }) and seals, and the sentinel
 *       the record carried is gone from the backend too;
 *   (e) a legacy stack that records an unfinished create of a reserved IP
 *       the program still declares: the deploy's up makes it again and
 *       tracks it at the same URN, and the record stays, so the user is told
 *       that IP's id as the one to keep and asked only about another by its
 *       name. The deploy after clears the record, never the IP, and seals.
 *   (f) the compose deploy's seal up on a recorded server
 *       (refuseLiveChanges, ruling R36): a plan that would resize the server
 *       in place, replace it (its user data changed and not ignored), delete
 *       it (the program no longer declares it) or create one (a stack that
 *       lost it) never applies, and neither does one that replaces another
 *       resource (the reserved IP's assignment, as a Scaleway IP replace
 *       would). The cloud keeps everything as it was, nothing is sealed and
 *       the ledger gets no marker. A plan that only updates a firewall rule
 *       in place applies it and seals, and so does the clean plan.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import * as pulumi from '@pulumi/pulumi';
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error: JS module without types
import { StateTracker } from '../../../src/lib/deploy/state.js';
import { SERVER_RESOURCE_TYPES } from '../../../src/lib/iac/create-timeout.js';
import {
  __resetStateProbesForTests,
  importStackState,
  upStack,
} from '../../../src/lib/iac/index.js';
import { LiveChangeRefusedError } from '../../../src/lib/iac/live-change-guard.js';
import {
  SECRET_SIG,
  SECRET_SIG_KEY,
  sealServerUserData,
  stateSealRecorded,
} from '../../../src/lib/iac/state-seal.js';
import { __workspaceDirsForTests, makeWorkspaceDir } from '../../../src/lib/iac/workspace-dir.js';
import {
  __resetStatePassphraseForTests,
  statePassphraseFingerprint,
} from '../../../src/lib/state-passphrase.js';

// The fake cloud's server is a server class, as each provider's is.
vi.mock('../../../src/lib/iac/create-timeout.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/iac/create-timeout.js')>();
  return {
    ...actual,
    SERVER_RESOURCE_TYPES: Object.freeze({
      ...actual.SERVER_RESOURCE_TYPES,
      'fakecloud:index:Server': {
        noun: 'server',
        nameInput: 'name',
        labelsInput: 'labels',
        locationInput: 'size',
        userDataInput: 'userData',
        imageInput: 'size',
      },
    }),
  };
});

// The provider the seal asks whether an unfinished create left a server: it
// lists one by that name that someone else made (no ownership labels).
const lookup = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/providers/index.js')>()),
  getProvider: () => ({
    findServersByName: async (name: string) => {
      lookup.calls.push(name);
      return [{ id: 'not-ours-1', labels: { team: 'web' } }];
    },
    serverLabels: (server: { labels?: Record<string, string> }) => server.labels ?? {},
  }),
}));

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PROJECT = 'sealtest';
const PASSPHRASE = 'c2VhbHNlYWxzZWFsc2VhbHNlYWxzZWFsc2VhbHNlYWxz';
// Sentinel only: a legacy cloud-init with a credential in it.
const SENTINEL = 'legacy-user-data-sentinel-3c8f';
const USER_DATA = `#cloud-config\n# token ${SENTINEL}\n`;

const root = mkdtempSync(join(tmpdir(), 'vc-state-seal-'));
const backend = join(root, 'state');
const cloudFile = join(root, 'cloud.json');
const projectDir = join(root, 'project');
const checkpoint = (stack: string) => join(backend, '.pulumi/stacks', PROJECT, `${stack}.json`);
const historyDir = (stack: string) => join(backend, '.pulumi/history', PROJECT, stack);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakecloud');
const opts = { projectName: PROJECT, projectDir };

class FakeServer extends pulumi.CustomResource {
  constructor(
    name: string,
    args: { size: string; userData: pulumi.Input<string> },
    opts?: pulumi.CustomResourceOptions,
  ) {
    super('fakecloud:index:Server', name, { ...args, ip: undefined }, opts);
  }
}

class FakeReservedIp extends pulumi.CustomResource {
  constructor(name: string, args: { name: string }, opts?: pulumi.CustomResourceOptions) {
    super('fakecloud:index:ReservedIp', name, { ...args, ipAddress: undefined }, opts);
  }
}

/**
 * A reserved IP's assignment to a server: any input change replaces it, so a
 * test changes `note` to plan a replace.
 */
class FakeIpAssignment extends pulumi.CustomResource {
  constructor(
    name: string,
    args: { ipAddress: pulumi.Input<string>; serverId: pulumi.Input<string>; note?: string },
  ) {
    super('fakecloud:index:ReservedIpAssignment', name, args, {});
  }
}

/** A firewall rule: any input change updates it in place. */
class FakeFirewallRule extends pulumi.CustomResource {
  constructor(name: string, args: { rule: string }) {
    super('fakecloud:index:FirewallRule', name, args, {});
  }
}

/**
 * The program before and after user data was wrapped in pulumi.secret. Both
 * keep it in ignoreChanges, as create-timeout.js serverResourceOptions does.
 */
const program = (wrapped: boolean) => async () => {
  const server = new FakeServer(
    'server',
    { size: 'small', userData: wrapped ? pulumi.secret(USER_DATA) : USER_DATA },
    { ignoreChanges: ['userData'] },
  );
  return { serverId: server.id };
};

/** A raw workspace under `passphrase`, in a directory the test setup removes. */
const rawWorkspace = (passphrase: string) => ({
  workDir: makeWorkspaceDir(),
  projectSettings: {
    name: PROJECT,
    runtime: 'nodejs' as const,
    backend: { url: `file://${backend}` },
  },
  envVars: {
    PULUMI_CONFIG_PASSPHRASE: passphrase,
    PULUMI_CONFIG_PASSPHRASE_FILE: undefined as unknown as string,
    PULUMI_SKIP_UPDATE_CHECK: 'true',
    // As production's buildEnv sets it (tests/unit/iac/build-env.test.ts), and
    // as every real stack was written since the first public release: no
    // `.pulumi/backups/` copies.
    PULUMI_DIY_BACKEND_DISABLE_CHECKPOINT_BACKUPS: 'true',
    FAKECLOUD_FILE: cloudFile,
    PATH: `${PLUGIN_DIR}:${process.env.PATH}`,
  },
});

/** An existing stack, opened with the project's passphrase outside the CLI. */
const rawStack = (stackName: string) =>
  LocalWorkspace.selectStack(
    { stackName, projectName: PROJECT, program: async () => ({}) },
    rawWorkspace(PASSPHRASE),
  );

/** Deploy `stackName` as a version before the passphrase did: '' and the plain program. */
async function writeLegacyStack(stackName: string, legacy = program(false)) {
  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName, projectName: PROJECT, program: legacy },
    rawWorkspace(''),
  );
  await stack.up();
}

const cloudServers = () => JSON.parse(readFileSync(cloudFile, 'utf8')).servers;
const holdsSentinel = (file: string) => readFileSync(file, 'utf8').includes(SENTINEL);

/** Every file under `dir`, relative to it. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(dir.length + 1));

/** The backend's files that hold the sentinel. */
const sentinelFiles = () => filesUnder(backend).filter((f) => holdsSentinel(join(backend, f)));

/** The names in a stack's history folder. */
const historyNames = (stack: string) =>
  existsSync(historyDir(stack)) ? readdirSync(historyDir(stack)) : [];

/** A ledger in the project dir, as the deploy's own (lib/deploy/state.js). */
function ledgerFor(environment: string) {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  try {
    return new StateTracker(PROJECT, environment);
  } finally {
    cwd.mockRestore();
  }
}

describe.runIf(hasPulumi || process.env.CI)('the seal after an up (real engine)', () => {
  let logged: string[];
  let warnings: string[];

  beforeAll(() => {
    mkdirSync(backend);
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      `${JSON.stringify({ stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) } })}\n`,
    );
    writeFileSync(cloudFile, JSON.stringify({ next: 1, servers: {} }));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  // Each test, not once: tests/setup/global-setup.ts resets process.env after
  // every test, and the iac layer hands its workspaces process.env.
  beforeEach(() => {
    expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    process.env.FAKECLOUD_FILE = cloudFile;
    process.env.PATH = `${PLUGIN_DIR}:${process.env.PATH}`;
    process.env.VIBECARBON_STATE_PASSPHRASE = PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    logged = [];
    warnings = [];
    // progressLog's line when no spinner is running.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    vi.spyOn(p.log, 'warn').mockImplementation((m: string) => {
      warnings.push(m);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sealCounts = () =>
    logged.flatMap((l) => {
      const m =
        /\[pulumi\] sealed (\d+) plain user data and k3s token values in (\S+)'s state/.exec(l);
      return m ? [`${m[2]}:${m[1]}`] : [];
    });
  const historyLines = () =>
    logged.flatMap((l) => {
      const m = /\[pulumi\] removed (\d+) of (\d+) history copies of (\S+)'s state/.exec(l);
      return m ? [{ stack: m[3], removed: Number(m[1]), checked: Number(m[2]) }] : [];
    });

  it('a legacy stack: refused before its up, sealed after it, stack file, .bak and history alike; a second deploy seals 0', async () => {
    await writeLegacyStack('e1');
    expect(holdsSentinel(checkpoint('e1'))).toBe(true);
    const before = cloudServers();
    expect(Object.keys(before)).toHaveLength(1);
    // The legacy up left a plain copy in its history, beside its list entry.
    const historyBefore = historyNames('e1');
    expect(historyBefore.filter((n) => n.endsWith('.history.json')).length).toBeGreaterThan(0);
    expect(
      historyBefore.filter(
        (n) => n.endsWith('.checkpoint.json') && holdsSentinel(join(historyDir('e1'), n)),
      ).length,
    ).toBeGreaterThan(0);
    // No `.pulumi/backups/`: the legacy writer ran as production does.
    expect(existsSync(join(backend, '.pulumi/backups'))).toBe(false);

    // Control (R20): sealed before the up, the import is refused. The stack
    // holds no secret, so the project's passphrase reads it, but its salt is
    // still the empty passphrase's, and Pulumi won't encrypt with it.
    const raw = await rawStack('e1');
    const early = sealServerUserData(await raw.exportStack(), SERVER_RESOURCE_TYPES);
    expect(early.count).toBe(2);
    await expect(importStackState(raw, early.deployment)).rejects.toThrow(
      /failed to encrypt: incorrect passphrase/,
    );
    expect(holdsSentinel(checkpoint('e1'))).toBe(true);

    // (a) The CLI's up of the wrapped program: a `same` step, then the seal.
    const ledger = ledgerFor('e1');
    expect(stateSealRecorded(ledger, 'e1')).toBe(false);
    await upStack('e1', program(true), { ...opts, ledger });

    // The server's user data, inputs and outputs: two values.
    expect(sealCounts()).toEqual(['e1:2']);
    expect(warnings).toEqual([]);
    expect(holdsSentinel(checkpoint('e1')), 'the stack checkpoint').toBe(false);
    expect(holdsSentinel(`${checkpoint('e1')}.bak`), 'the checkpoint Pulumi kept as .bak').toBe(
      false,
    );
    // Nothing anywhere in the backend: history copies included.
    expect(sentinelFiles()).toEqual([]);
    const [cleanup] = historyLines();
    expect(cleanup.stack).toBe('e1');
    expect(cleanup.removed).toBeGreaterThan(0);
    // Every history list entry stays, and no sidecar outlives its file.
    const historyAfter = historyNames('e1');
    for (const name of historyBefore.filter((n) => n.endsWith('.history.json'))) {
      expect(historyAfter).toContain(name);
    }
    for (const attrs of historyAfter.filter((n) => n.endsWith('.attrs'))) {
      expect(historyAfter).toContain(attrs.slice(0, -'.attrs'.length));
    }
    expect(stateSealRecorded(ledger, 'e1')).toBe(true);
    expect(cloudServers()).toEqual(before);

    // The sealed values open to what they held: Pulumi encrypted the exact
    // user data, inputs and outputs alike.
    const sealedServer = (
      await rawStack('e1').then((s) => s.exportStack())
    ).deployment.resources.find((r: { type: string }) => r.type === 'fakecloud:index:Server');
    for (const side of ['inputs', 'outputs'] as const) {
      const value = sealedServer[side].userData;
      expect(value[SECRET_SIG_KEY], `${side}.userData is a secret`).toBe(SECRET_SIG);
      expect(JSON.parse(value.plaintext), `${side}.userData`).toBe(USER_DATA);
    }

    // (b) A later deploy: a new process, a refresh, an up.
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    logged.length = 0;
    await upStack('e1', program(true), { ...opts, ledger: ledgerFor('e1') });

    expect(sealCounts()).toEqual(['e1:0']);
    expect(historyLines(), 'the marker is set: no history read').toEqual([]);
    expect(warnings).toEqual([]);
    expect(sentinelFiles()).toEqual([]);
    expect(cloudServers(), 'the server was neither replaced nor changed').toEqual(before);

    // (c) Every workspace this file opened, with nothing an import wrote left in it.
    const leftovers = __workspaceDirsForTests().flatMap((dir) =>
      readdirSync(dir).filter((name) => name.startsWith('state-import-')),
    );
    expect(leftovers).toEqual([]);
  });

  it("(d) an unfinished server create on a legacy stack: the only server by that name isn't ours, so the deploy leaves it alone, clears the record and seals", async () => {
    await writeLegacyStack('e4');
    // An earlier run's create of a second server, interrupted: Pulumi keeps
    // it under pending_operations, plain user data and all.
    const file = checkpoint('e4');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const latest = saved.checkpoint.latest;
    const server = latest.resources.find(
      (r: { type: string }) => r.type === 'fakecloud:index:Server',
    );
    latest.pending_operations = [
      {
        type: 'creating',
        resource: {
          urn: server.urn.replace(/::server$/, '::ghost'),
          custom: true,
          type: server.type,
          inputs: {
            name: 'sealtest-e4-ghost',
            size: 'small',
            userData: USER_DATA,
            // The ownership labels every program sets on its servers.
            labels: { project: 'sealtest', environment: 'e4', 'managed-by': 'vibecarbon' },
          },
          parent: server.parent,
          provider: server.provider,
        },
      },
    ];
    writeFileSync(file, JSON.stringify(saved));
    const before = cloudServers();
    lookup.calls.length = 0;

    const ledger = ledgerFor('e4');
    await upStack('e4', program(true), {
      ...opts,
      ledger,
      provider: 'hetzner',
      providerToken: 't',
    });

    expect(lookup.calls).toEqual(['sealtest-e4-ghost']);
    expect(warnings).toEqual([]);
    expect(logged).toContain(
      "[pulumi] state seal for e4 leaves alone sealtest-e4-ghost (id not-ours-1): same name, but without this environment's ownership labels, so not vibecarbon's",
    );
    expect(logged).toContain(
      "[pulumi] cleared 1 unfinished create from e4's state: server sealtest-e4-ghost",
    );
    expect(sealCounts()).toEqual(['e4:2']);
    const exported = (await rawStack('e4').then((s) => s.exportStack())).deployment;
    expect(exported.pending_operations ?? []).toEqual([]);
    // The record the clear dropped held the sentinel too: nothing anywhere.
    expect(sentinelFiles()).toEqual([]);
    expect(stateSealRecorded(ledger, 'e4')).toBe(true);
    expect(cloudServers()).toEqual(before);
  });

  it('(e) an unfinished create of a reserved IP the program still declares: the up makes it again, the user is told its id as the one to keep, and the next deploy clears the record, never the IP, and seals', async () => {
    await writeLegacyStack('e5');
    // An earlier run's create of the ingress IP, interrupted before Pulumi
    // recorded any IP: only the record of the create.
    const file = checkpoint('e5');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const latest = saved.checkpoint.latest;
    const server = latest.resources.find(
      (r: { type: string }) => r.type === 'fakecloud:index:Server',
    );
    const ipUrn = server.urn.replace(
      /fakecloud:index:Server::server$/,
      'fakecloud:index:ReservedIp::ingress',
    );
    latest.pending_operations = [
      {
        type: 'creating',
        resource: {
          urn: ipUrn,
          custom: true,
          type: 'fakecloud:index:ReservedIp',
          inputs: { name: 'sealtest-e5-ip' },
          parent: server.parent,
          provider: server.provider,
        },
      },
    ];
    writeFileSync(file, JSON.stringify(saved));
    const withIp = async () => {
      const made = await program(true)();
      new FakeReservedIp('ingress', { name: 'sealtest-e5-ip' });
      return made;
    };
    const ips = () =>
      Object.keys(
        JSON.parse(readFileSync(cloudFile, 'utf8')).things?.['fakecloud:index:ReservedIp'] ?? {},
      );
    lookup.calls.length = 0;

    await upStack('e5', withIp, {
      ...opts,
      ledger: ledgerFor('e5'),
      provider: 'hetzner',
      providerToken: 't',
    });

    // The engine's own shape: the IP made again and tracked, the record kept.
    expect(ips()).toHaveLength(1);
    const [ipId] = ips();
    const afterUp = (await rawStack('e5').then((s) => s.exportStack())).deployment;
    expect(afterUp.resources.find((r: { urn: string }) => r.urn === ipUrn)).toMatchObject({
      id: ipId,
    });
    expect(
      afterUp.pending_operations.map((o: { resource: { urn: string } }) => o.resource.urn),
    ).toEqual([ipUrn]);
    expect(lookup.calls).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      `Keep the reserved IP sealtest-e5-ip (id ${ipId}): a later run made it again, and it's the one this project uses. ` +
        "vibecarbon can't tell whether the earlier create also made another reserved IP named sealtest-e5-ip, " +
        "so check your Hetzner Cloud console for one and delete it if it's this project's. " +
        'Another reserved IP named sealtest-e5-ip would be billing you while it exists.',
    );
    expect(warnings[0]).not.toContain("can't tell whether that create made");
    expect(sealCounts(), 'nothing imported over the record').toEqual([]);
    expect(stateSealRecorded(ledgerFor('e5'), 'e5')).toBe(false);

    // "Then deploy again".
    logged.length = 0;
    warnings.length = 0;
    __resetStateProbesForTests();
    await upStack('e5', withIp, {
      ...opts,
      ledger: ledgerFor('e5'),
      provider: 'hetzner',
      providerToken: 't',
    });

    expect(warnings).toEqual([]);
    expect(logged).toContain(
      "[pulumi] cleared 1 unfinished create from e5's state: reserved IP sealtest-e5-ip",
    );
    expect(sealCounts()).toEqual(['e5:2']);
    const sealed = (await rawStack('e5').then((s) => s.exportStack())).deployment;
    expect(sealed.pending_operations ?? []).toEqual([]);
    expect(sealed.resources.find((r: { urn: string }) => r.urn === ipUrn)).toMatchObject({
      id: ipId,
    });
    expect(ips(), 'the IP to keep was kept').toEqual([ipId]);
    expect(sentinelFiles()).toEqual([]);
    expect(stateSealRecorded(ledgerFor('e5'), 'e5')).toBe(true);
  });
  it('(f) the seal up on a recorded server: a plan that changes the server, or replaces or deletes anything, never applies; a firewall rule update and the clean plan seal', async () => {
    await writeLegacyStack('e6');
    const before = cloudServers();
    const ledger = ledgerFor('e6');
    const refusing = { ...opts, ledger, refuseLiveChanges: true };
    /** The changes the refusal upStack throws names, read back. */
    const refusal = async (stack: string, prog: () => Promise<unknown>) => {
      const err = await upStack(stack, prog as never, refusing).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LiveChangeRefusedError);
      return [
        ...new Set(
          (err as InstanceType<typeof LiveChangeRefusedError>).changes.map(
            (c: { action: string; kind: string; name: string }) =>
              `${c.action} ${c.kind} ${c.name}`,
          ),
        ),
      ];
    };
    /** The program of today with the server at `size`, user data ignored. */
    const sized = (size: string) => async () => {
      const server = new FakeServer(
        'server',
        { size, userData: pulumi.secret(USER_DATA) },
        { ignoreChanges: ['userData'] },
      );
      return { serverId: server.id };
    };

    // An in-place update: a resize stops a server this deploy never touched.
    expect(await refusal('e6', sized('large'))).toEqual(['update Server server']);
    // Replace: changed user data the program no longer ignores.
    const replacing = async () => {
      const server = new FakeServer('server', {
        size: 'small',
        userData: pulumi.secret(`${USER_DATA}# changed\n`),
      });
      return { serverId: server.id };
    };
    expect(await refusal('e6', replacing)).toEqual(['replace Server server']);
    // Delete: the program no longer declares the server.
    expect(await refusal('e6', async () => ({}))).toEqual(['delete Server server']);
    // Create: a stack that holds no server, as one that lost the record would.
    expect(await refusal('e6-lost', program(true))).toEqual(['create Server server']);

    expect(cloudServers(), 'the cloud kept its one server, unchanged').toEqual(before);
    expect(sealCounts(), 'no up ran, so no seal').toEqual([]);
    expect(stateSealRecorded(ledger, 'e6')).toBe(false);
    expect(holdsSentinel(checkpoint('e6')), 'the state stays as it was').toBe(true);

    // The clean plan: the up runs and seals.
    await upStack('e6', program(true), refusing);
    expect(sealCounts()).toEqual(['e6:2']);
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledger, 'e6')).toBe(true);
    expect(holdsSentinel(checkpoint('e6'))).toBe(false);
    expect(cloudServers()).toEqual(before);
  });

  it('(f) around the server: a replaced IP assignment never applies, as a Scaleway IP replace would not; a firewall rule updated in place applies and seals', async () => {
    /** The server, its reserved IP and that IP's assignment, and a firewall rule. */
    const networked =
      (wrapped: boolean, { rule = 'allow 22', note }: { rule?: string; note?: string } = {}) =>
      async () => {
        const made = (await program(wrapped)()) as { serverId: pulumi.Output<string> };
        const ip = new FakeReservedIp('ingress', { name: 'sealtest-e7-ip' });
        new FakeIpAssignment('ingress-assignment', {
          // The IP's id is its address. The fake's ReservedIp plans an update
          // on every up (its diff reads the address it outputs as a changed
          // input), so a preview holds its outputs unknown, and an assignment
          // fed `ip.ipAddress` would plan a replace on every preview.
          ipAddress: ip.id,
          serverId: made.serverId,
          ...(note && { note }),
        });
        new FakeFirewallRule('ssh', { rule });
        return made;
      };
    await writeLegacyStack('e7', networked(false));
    const cloud = () => JSON.parse(readFileSync(cloudFile, 'utf8'));
    const before = cloud();
    const ledger = ledgerFor('e7');
    const refusing = { ...opts, ledger, refuseLiveChanges: true };

    const err = await upStack('e7', networked(true, { note: 'moved' }), refusing).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LiveChangeRefusedError);
    expect((err as Error).message).toMatch(
      /^The up for e7 would change ReservedIpAssignment ingress-assignment \(replace\), so it didn't run/,
    );
    expect(cloud(), 'the server, the IP and its assignment as they were').toEqual(before);
    expect(sealCounts()).toEqual([]);
    expect(stateSealRecorded(ledger, 'e7')).toBe(false);

    // Only the firewall rule changes, in place: it applies, and the stack seals.
    await upStack('e7', networked(true, { rule: 'allow 22 from 198.51.100.0/24' }), refusing);
    expect(sealCounts()).toEqual(['e7:2']);
    expect(warnings).toEqual([]);
    expect(stateSealRecorded(ledger, 'e7')).toBe(true);
    const after = cloud();
    expect(after.servers, 'the server untouched').toEqual(before.servers);
    expect(Object.values(after.things['fakecloud:index:FirewallRule'])).toEqual([
      { rule: 'allow 22 from 198.51.100.0/24' },
    ]);
    expect(after.things['fakecloud:index:ReservedIpAssignment']).toEqual(
      before.things['fakecloud:index:ReservedIpAssignment'],
    );
  });
});
