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
 *       import goes through; the legacy user data sentinel is gone from the
 *       stack's checkpoint and from the copy Pulumi keeps as its .bak; the
 *       servers are untouched;
 *   (b) a second deploy (refresh, then up) hands the sealed values back
 *       sealed: it seals 0, and the server is still not replaced;
 *   (c) no import leaves its deployment file behind.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import * as pulumi from '@pulumi/pulumi';
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_RESOURCE_TYPES } from '../../../src/lib/iac/create-timeout.js';
import {
  __resetStateProbesForTests,
  importStackState,
  upStack,
} from '../../../src/lib/iac/index.js';
import { sealServerUserData } from '../../../src/lib/iac/state-seal.js';
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
    FAKECLOUD_FILE: cloudFile,
    PATH: `${PLUGIN_DIR}:${process.env.PATH}`,
  },
});

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

  it('a legacy stack: refused before its up, sealed after it, stack file and .bak alike; a second deploy seals 0', async () => {
    await writeLegacyStack('e1');
    expect(holdsSentinel(checkpoint('e1'))).toBe(true);
    const before = cloudServers();
    expect(Object.keys(before)).toHaveLength(1);

    // Control (R20): sealed before the up, the import is refused. The stack
    // holds no secret, so the project's passphrase reads it, but its salt is
    // still the empty passphrase's, and Pulumi won't encrypt with it.
    const raw = await LocalWorkspace.selectStack(
      { stackName: 'e1', projectName: PROJECT, program: async () => ({}) },
      rawWorkspace(PASSPHRASE),
    );
    const early = sealServerUserData(await raw.exportStack(), SERVER_RESOURCE_TYPES);
    expect(early.count).toBe(2);
    await expect(importStackState(raw, early.deployment)).rejects.toThrow(
      /failed to encrypt: incorrect passphrase/,
    );
    expect(holdsSentinel(checkpoint('e1'))).toBe(true);

    // (a) The CLI's up of the wrapped program: a `same` step, then the seal.
    await upStack('e1', program(true), opts);

    // The server's user data, inputs and outputs: two values.
    expect(sealCounts()).toEqual(['e1:2']);
    expect(warnings).toEqual([]);
    expect(holdsSentinel(checkpoint('e1')), 'the stack checkpoint').toBe(false);
    expect(holdsSentinel(`${checkpoint('e1')}.bak`), 'the checkpoint Pulumi kept as .bak').toBe(
      false,
    );
    expect(cloudServers()).toEqual(before);

    // (b) A later deploy: a new process, a refresh, an up.
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    logged.length = 0;
    await upStack('e1', program(true), opts);

    expect(sealCounts()).toEqual(['e1:0']);
    expect(warnings).toEqual([]);
    expect(holdsSentinel(checkpoint('e1'))).toBe(false);
    expect(holdsSentinel(`${checkpoint('e1')}.bak`)).toBe(false);
    expect(cloudServers(), 'the server was neither replaced nor changed').toEqual(before);

    // (c) Every workspace this file opened, with nothing an import wrote left in it.
    const leftovers = __workspaceDirsForTests().flatMap((dir) =>
      readdirSync(dir).filter((name) => name.startsWith('state-import-')),
    );
    expect(leftovers).toEqual([]);
  });
});
