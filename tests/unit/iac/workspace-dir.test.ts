/**
 * Every Pulumi workspace the iac layer opens runs in a directory it made
 * (lib/iac/workspace-dir.js), and every one is removed at process exit. The
 * Automation SDK makes its own `automation-*` directory when handed none, and
 * never removes it: one per stack open was left in the OS temp dir.
 *
 * The SDK is mocked here to see which directory each workspace gets and that
 * it exists while the workspace runs. The exit hook in a real process is
 * tests/integration/iac/workspace-dir-exit.test.ts.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Each workspace the SDK was asked for: the call, its workDir, and whether it existed. */
const opened = vi.hoisted(
  () => [] as { call: string; workDir: string | undefined; existed: boolean }[],
);
const behaviour = vi.hoisted(() => ({ select: 'ok' as 'ok' | 'missing' }));

vi.mock('@pulumi/pulumi/automation/index.js', async () => {
  const { existsSync: exists } = await import('node:fs');
  const record = (call: string, opts: { workDir?: string }) =>
    opened.push({
      call,
      workDir: opts?.workDir,
      existed: Boolean(opts?.workDir && exists(opts.workDir)),
    });
  const stack = (name: string, workDir: string | undefined) => ({
    name,
    workspace: { workDir },
  });
  return {
    LocalWorkspace: {
      selectStack: async (args: { stackName: string }, opts: { workDir?: string }) => {
        record('selectStack', opts);
        if (behaviour.select === 'missing') {
          throw new Error(`no stack named '${args.stackName}' found`);
        }
        return stack(args.stackName, opts.workDir);
      },
      createStack: async (args: { stackName: string }, opts: { workDir?: string }) => {
        record('createStack', opts);
        return stack(args.stackName, opts.workDir);
      },
      create: async (opts: { workDir?: string }) => {
        record('create', opts);
        return { listStacks: async () => [], whoAmI: async () => ({ user: 'me' }) };
      },
    },
  };
});

const { getOrCreateStack, listStacks, openStateBackend } = await import(
  '../../../src/lib/iac/index.js'
);
const { __workspaceDirsForTests, makeWorkspaceDir, removeWorkspaceDirs } = await import(
  '../../../src/lib/iac/workspace-dir.js'
);
const { sweepTempDirs } = await import('../../../src/lib/temp-dir.js');

const BASE = {
  projectName: 'proj',
  provider: 'hetzner',
  s3Config: {
    bucket: 'b',
    stateBucket: 'b-pulumi-state',
    region: 'fsn1',
    endpoint: 'https://fsn1.your-objectstorage.com',
    accessKey: 'AKIATEST',
    secretKey: 'secret',
  },
  // These tests are about the directory, not the passphrase.
  decrypts: false,
};

beforeEach(() => {
  opened.length = 0;
  behaviour.select = 'ok';
  removeWorkspaceDirs();
});

afterEach(() => {
  removeWorkspaceDirs();
});

describe('makeWorkspaceDir and removeWorkspaceDirs', () => {
  it('a new empty private vibecarbon-pulumi-* directory under the OS temp dir each time, all removed together', () => {
    const a = makeWorkspaceDir();
    const b = makeWorkspaceDir();
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      expect(dirname(dir)).toBe(tmpdir());
      expect(basename(dir)).toMatch(/^vibecarbon-pulumi-/);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir)).toEqual([]);
    }
    // What a workspace leaves in one: its project file and the stack's salt.
    writeFileSync(join(a, 'Pulumi.yaml'), 'name: proj\n');
    writeFileSync(join(a, 'Pulumi.e1.yaml'), 'encryptionsalt: v1:abc\n');
    expect(__workspaceDirsForTests()).toEqual([a, b]);

    removeWorkspaceDirs();

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(__workspaceDirsForTests()).toEqual([]);
  });

  it("are on temp-dir.js's exit sweep, which removes them at process exit", () => {
    const a = makeWorkspaceDir();
    writeFileSync(join(a, 'Pulumi.yaml'), 'name: proj\n');
    const b = makeWorkspaceDir();
    // The 'exit' listener runs exactly this.
    sweepTempDirs({ report: () => {} });
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    // Already gone: removing them again is a no-op.
    expect(() => removeWorkspaceDirs()).not.toThrow();
    expect(__workspaceDirsForTests()).toEqual([]);
  });
});

describe('every workspace the iac layer opens runs in a directory it removes', () => {
  /** The opens so far: each had its own directory, and it existed while the SDK ran. */
  function expectOwnDirectories(calls: string[]) {
    expect(opened.map((o) => o.call)).toEqual(calls);
    const dirs = opened.map((o) => o.workDir);
    expect(opened.every((o) => o.existed)).toBe(true);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(__workspaceDirsForTests()).toEqual(dirs);
    removeWorkspaceDirs();
    for (const dir of dirs) expect(existsSync(dir as string)).toBe(false);
  }

  it('getOrCreateStack: the stack it hands out runs in that directory until exit', async () => {
    const stack = await getOrCreateStack('e1', async () => ({}), BASE);
    expect(stack.workspace.workDir).toBe(opened[0].workDir);
    // Still there after the open: the caller's up or destroy runs in it.
    expect(existsSync(stack.workspace.workDir)).toBe(true);
    expectOwnDirectories(['selectStack']);
  });

  it('a first deploy: the failed select, the listing and the create each get one, all removed', async () => {
    behaviour.select = 'missing';
    await getOrCreateStack('e1', async () => ({}), BASE);
    expectOwnDirectories(['selectStack', 'create', 'createStack']);
  });

  it('a select that must find an existing stack and does not: its directory is removed too', async () => {
    behaviour.select = 'missing';
    await expect(
      getOrCreateStack('e1', async () => ({}), { ...BASE, requireExisting: true }),
    ).rejects.toThrow(/was not found/);
    expectOwnDirectories(['selectStack']);
  });

  it('listStacks and openStateBackend', async () => {
    await listStacks(BASE);
    await openStateBackend(BASE);
    expectOwnDirectories(['create', 'create']);
  });
});
