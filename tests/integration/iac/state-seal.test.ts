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
 *   (c) no import leaves its deployment file behind.
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
        locationInput: 'size',
        userDataInput: 'userData',
        imageInput: 'size',
      },
    }),
  };
});

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
async function writeLegacyStack(stackName: string) {
  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName, projectName: PROJECT, program: program(false) },
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
});
