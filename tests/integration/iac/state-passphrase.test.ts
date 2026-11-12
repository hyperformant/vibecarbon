/**
 * The one-time legacy migration on the real Pulumi engine: a file:// backend
 * in a tmp dir and the fake cloud's resource plugin (fakecloud/).
 *
 * Every stack written before the per-project passphrase was encrypted with
 * the empty one. getOrCreateStack reads each stack once per process with a
 * full export, and on a passphrase refusal re-encrypts it through `pulumi
 * stack change-secrets-provider passphrase` ('' in the environment, the
 * project's passphrase on stdin). Pinned here against the CLI itself:
 *   (a) a legacy stack with secrets migrates on its first open: its outputs
 *       read, and '' no longer opens it;
 *   (b) a stack under some other passphrase is the typed error, and its
 *       checkpoint is byte-for-byte what it was;
 *   (c) a fresh workspace (a later process) re-opens it with no migration;
 *   (d) destroy migrates a legacy stack and destroys it through Pulumi, so it
 *       never reaches destroy's path for a state it cannot read;
 *   (e) a stack whose only secret sits in a resource input answers `stack
 *       output` under the wrong passphrase (E7), so only the export finds it;
 *       an up migrates it on the open and goes ahead;
 *   (f) `change-secrets-provider` takes the stack's lock (`stack export` does
 *       not): behind a lock a dead run left, the lock is cleared and the
 *       stack migrated;
 *   (g) behind a live run's lock: StackHeldError, the state untouched and
 *       still readable with '', never the typed error.
 *
 * Remove with the migration after 2027-02-11.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import * as pulumi from '@pulumi/pulumi';
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStateProbesForTests,
  destroyStack,
  getStackOutputs,
  upStack,
} from '../../../src/lib/iac/index.js';
import { StackHeldError } from '../../../src/lib/iac/stack-lock.js';
import { StateUndecryptableError } from '../../../src/lib/iac/state-error.js';
import { makeWorkspaceDir } from '../../../src/lib/iac/workspace-dir.js';
import {
  __resetStatePassphraseForTests,
  statePassphraseFingerprint,
} from '../../../src/lib/state-passphrase.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PROJECT = 'migrationtest';
const PASSPHRASE = 'bWlncmF0aW9ubWlncmF0aW9ubWlncmF0aW9ubWlncmF0';
const OTHER = 'b3RoZXJvdGhlcm90aGVyb3RoZXJvdGhlcm90aGVyb3Ro';
const SENTINEL = 'integration-sentinel';
const USER_DATA = '#cloud-config user-data-sentinel';

const root = createTempDir('vc-passphrase-migration-');
const backend = join(root, 'state');
const cloudFile = join(root, 'cloud.json');
const projectDir = join(root, 'project');
const checkpoint = (stack: string) => join(backend, '.pulumi/stacks', PROJECT, `${stack}.json`);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakecloud');
const opts = { projectName: PROJECT, projectDir };
const migratedLine = (stack: string) =>
  `Your Pulumi state for ${stack} was stored with an empty passphrase. vibecarbon re-encrypted it with this project's passphrase.`;

class FakeServer extends pulumi.CustomResource {
  constructor(name: string, args: { size: string; userData: pulumi.Input<string> }) {
    super('fakecloud:index:Server', name, { ...args, ip: undefined }, {});
  }
}

/**
 * A compose stack's shape where it matters: a server whose user data is a
 * secret (as Linode's rootPass and Vultr's password are in their providers'
 * state), and optionally a secret stack output.
 */
const program =
  ({ secretOutput }: { secretOutput: boolean }) =>
  async () => {
    const server = new FakeServer('server', {
      size: 'small',
      userData: pulumi.secret(USER_DATA),
    });
    return {
      serverId: server.id,
      ...(secretOutput ? { token: pulumi.secret(SENTINEL) } : {}),
    };
  };

/**
 * A raw workspace under `passphrase`, as the CLI opened stacks before (with
 * ''), in a directory the test setup removes after this file.
 */
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

/** Deploy `stackName` with `passphrase`: '' writes a legacy stack. */
async function writeStack(stackName: string, passphrase: string, secretOutput: boolean) {
  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName, projectName: PROJECT, program: program({ secretOutput }) },
    rawWorkspace(passphrase),
  );
  await stack.up();
}

/** A full export of `stackName` with `passphrase`, as the probe reads it. */
async function exportWith(stackName: string, passphrase: string) {
  const stack = await LocalWorkspace.selectStack(
    { stackName, projectName: PROJECT, program: async () => ({}) },
    rawWorkspace(passphrase),
  );
  return stack.exportStack();
}

const servers = () => Object.keys(JSON.parse(readFileSync(cloudFile, 'utf8')).servers);

/**
 * A lock on `stackName` in the backend, as a run that took it and never let
 * go leaves it (the DIY backend's lock file and its fields).
 */
function lockStack(stackName: string, holder: { host: string; pid: number; at: string }) {
  const dir = join(backend, '.pulumi/locks/organization', PROJECT, stackName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '6f1d2c3b-0000-4000-8000-000000000001.json');
  writeFileSync(
    file,
    JSON.stringify({
      pid: holder.pid,
      username: 'someone',
      hostname: holder.host,
      timestamp: holder.at,
    }),
  );
  return file;
}

describe.runIf(hasPulumi || process.env.CI)('legacy empty-passphrase stacks (real engine)', () => {
  let infos: string[];

  beforeAll(() => {
    mkdirSync(backend);
    mkdirSync(projectDir);
    // A project that already records its passphrase's fingerprint: the only
    // thing a first open has to say is the migration.
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      `${JSON.stringify({ stateEncryption: { fingerprint: statePassphraseFingerprint(PASSPHRASE) } })}\n`,
    );
    writeFileSync(cloudFile, JSON.stringify({ next: 1, servers: {} }));
  });
  afterAll(() => {
    cleanupTempDir(root);
  });
  // Each test, not once: tests/setup/global-setup.ts resets process.env after
  // every test. The iac layer hands its workspaces process.env, so the
  // backend, the plugin on PATH and its cloud file reach every Pulumi call.
  beforeEach(() => {
    expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
    process.env.FAKECLOUD_FILE = cloudFile;
    process.env.PATH = `${PLUGIN_DIR}:${process.env.PATH}`;
    process.env.VIBECARBON_STATE_PASSPHRASE = PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    // A new process, as far as both memos go.
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    infos = [];
    vi.spyOn(p.log, 'info').mockImplementation((m: string) => {
      infos.push(m);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) a legacy stack with secrets migrates on its first open: outputs read, and the empty passphrase no longer opens it', async () => {
    await writeStack('legacy-a', '', true);
    // A real legacy stack: '' reads it, the project's passphrase does not.
    await expect(exportWith('legacy-a', '')).resolves.toBeDefined();
    await expect(exportWith('legacy-a', PASSPHRASE)).rejects.toThrow(/incorrect passphrase/);

    const outputs = await getStackOutputs('legacy-a', async () => ({}), opts);

    expect(outputs.token).toBe(SENTINEL);
    expect(outputs.serverId).toEqual(expect.any(String));
    expect(infos).toEqual([migratedLine('legacy-a')]);
    await expect(exportWith('legacy-a', '')).rejects.toThrow(/incorrect passphrase/);
    const state = JSON.stringify(await exportWith('legacy-a', PASSPHRASE));
    expect(state).toContain('user-data-sentinel');
    // Re-encrypted, not decrypted: the checkpoint on disk holds neither secret.
    const onDisk = readFileSync(checkpoint('legacy-a'), 'utf8');
    expect(onDisk).not.toContain(SENTINEL);
    expect(onDisk).not.toContain('user-data-sentinel');
  });

  it('(b) a stack under some other passphrase: the typed error, its checkpoint unchanged byte for byte', async () => {
    await writeStack('foreign', OTHER, true);
    const before = readFileSync(checkpoint('foreign'));

    const read = await getStackOutputs('foreign', async () => ({}), opts).catch((e: unknown) => e);
    expect(read).toBeInstanceOf(StateUndecryptableError);
    expect((read as Error).message).toContain("can't decrypt the Pulumi state for foreign");
    // The up path stops at the same open, before its refresh or up.
    const up = await upStack('foreign', program({ secretOutput: true }), opts).catch(
      (e: unknown) => e,
    );
    expect(up).toBeInstanceOf(StateUndecryptableError);

    // The migration with '' was tried and refused; nothing was written.
    expect(readFileSync(checkpoint('foreign')).equals(before)).toBe(true);
    await expect(exportWith('foreign', OTHER)).resolves.toBeDefined();
    expect(infos).toEqual([]);
  });

  it('(c) a fresh workspace in a later process re-opens a migrated stack, with no migration', async () => {
    await writeStack('legacy-c', '', true);
    await getStackOutputs('legacy-c', async () => ({}), opts);
    expect(infos).toEqual([migratedLine('legacy-c')]);

    // A later process: both memos forgotten, and every open is a new workspace.
    __resetStatePassphraseForTests();
    __resetStateProbesForTests();
    infos.length = 0;
    const outputs = await getStackOutputs('legacy-c', async () => ({}), opts);

    expect(outputs.token).toBe(SENTINEL);
    expect(infos).toEqual([]);
  });

  it('(d) destroy migrates a legacy stack and destroys it through Pulumi: the server goes with the stack', async () => {
    await writeStack('legacy-d', '', false);
    const before = servers();

    const result = await destroyStack('legacy-d', async () => ({}), opts);

    expect(result).toMatchObject({ destroyed: true });
    expect(infos).toEqual([migratedLine('legacy-d')]);
    // Pulumi deleted the server in the cloud, then removed the stack.
    expect(servers().length).toBe(before.length - 1);
    expect(existsSync(checkpoint('legacy-d'))).toBe(false);
  });

  it('(e) a secret only in a resource input: `stack output` reads under the wrong passphrase, so the export is the probe; an up migrates and goes ahead', async () => {
    await writeStack('legacy-e', '', false);
    // E7: the project's passphrase answers `stack output` on this legacy
    // stack, and only the full export refuses it.
    const raw = await LocalWorkspace.selectStack(
      { stackName: 'legacy-e', projectName: PROJECT, program: async () => ({}) },
      rawWorkspace(PASSPHRASE),
    );
    const before = await raw.outputs();
    expect(before).toHaveProperty('serverId');
    await expect(raw.exportStack()).rejects.toThrow(/incorrect passphrase/);
    const serversBefore = servers().length;

    const { outputs } = await upStack('legacy-e', program({ secretOutput: false }), opts);

    expect(outputs.serverId).toEqual(expect.any(String));
    expect(infos).toEqual([migratedLine('legacy-e')]);
    // The same server: the fake cloud's diff compares the revealed user data,
    // as bridged providers do, so the migrated up replaces nothing.
    expect(servers().length).toBe(serversBefore);
    expect(outputs.serverId).toBe(before.serverId.value);
    await expect(exportWith('legacy-e', '')).rejects.toThrow(/incorrect passphrase/);
  });

  it('(f) behind a lock a dead run left: the lock is cleared and the stack migrated, and the empty passphrase no longer opens it', async () => {
    await writeStack('legacy-f', '', true);
    // Past the two-hour expiry, from a machine this one cannot see.
    const lock = lockStack('legacy-f', {
      host: 'ci-runner-long-gone',
      pid: 4321,
      at: '2026-01-01T00:00:00Z',
    });

    const outputs = await getStackOutputs('legacy-f', async () => ({}), opts);

    expect(outputs.token).toBe(SENTINEL);
    expect(infos).toEqual([migratedLine('legacy-f')]);
    expect(existsSync(lock)).toBe(false);
    await expect(exportWith('legacy-f', '')).rejects.toThrow(/incorrect passphrase/);
    await expect(exportWith('legacy-f', PASSPHRASE)).resolves.toBeDefined();
  });

  it("(g) behind a live run's lock: StackHeldError, the state untouched and still the empty passphrase's; once the run is gone it migrates", async () => {
    await writeStack('legacy-g', '', true);
    const before = readFileSync(checkpoint('legacy-g'));
    // This very process, just now.
    const lock = lockStack('legacy-g', {
      host: hostname(),
      pid: process.pid,
      at: new Date().toISOString(),
    });

    const err = await getStackOutputs('legacy-g', async () => ({}), opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StackHeldError);
    expect(err).not.toBeInstanceOf(StateUndecryptableError);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(checkpoint('legacy-g')).equals(before)).toBe(true);
    await expect(exportWith('legacy-g', '')).resolves.toBeDefined();
    expect(infos).toEqual([]);

    // The run finishes and lets go: the next open migrates it.
    rmSync(lock);
    const outputs = await getStackOutputs('legacy-g', async () => ({}), opts);
    expect(outputs.token).toBe(SENTINEL);
    expect(infos).toEqual([migratedLine('legacy-g')]);
  });
});
