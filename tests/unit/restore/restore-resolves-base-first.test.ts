/**
 * H3: `vibecarbon restore` resolves the exact base backup in the CLI, from the
 * stop sentinels in the backup bucket, BEFORE anything on the server stops.
 * With no restorable base the command must refuse while the database is still
 * serving: no `docker compose stop`, no `kubectl patch` of the restore marker,
 * no app scale-down.
 *
 * `run` is driven end to end with a fake S3 client holding zero sentinels; the
 * SSH transports (runCommandAsync for compose, sshKubectl for k8s) are spies.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const keyDir = mkdtempSync(join(tmpdir(), 'vc-restore-base-'));
const keyPath = join(keyDir, 'id_ed25519');
writeFileSync(keyPath, 'not-a-key');

let envConfig: Record<string, unknown> = {};

vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => ({ projectName: 'myapp', environments: { prod: envConfig } }),
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/cli/env-context.js', () => ({
  resolveEnvContext: async () => ({ envName: 'prod', envConfig, serverIp: '10.0.0.1' }),
}));
// No provider token: the operator-IP firewall refresh never reaches a real API.
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/providers/index.js')>();
  return { ...actual, resolveProviderToken: () => null };
});
vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/command.js')>();
  return { ...actual, runCommandAsync: vi.fn(async () => '') };
});
vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/ssh.js')>();
  return {
    ...actual,
    getSSHKeyPath: () => keyPath,
    getPostgresPod: vi.fn(async () => 'db-0'),
    sshKubectl: vi.fn(async () => ''),
    sshRun: vi.fn(async () => ''),
    sshRunScript: vi.fn(async () => ''),
  };
});

const { run, runComposeRestore, runK8sRestore } = await import('../../../src/restore.js');
const { runCommandAsync } = await import('../../../src/lib/command.js');
const ssh = await import('../../../src/lib/ssh.js');

/** An S3 client whose bucket holds no stop sentinel at all. */
function emptyS3() {
  const sent: string[] = [];
  return {
    sent,
    async send(cmd: { constructor: { name: string } }) {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
}

const S3 = {
  bucket: 'myapp-backups',
  endpoint: 'https://fsn1.your-objectstorage.com',
  region: 'fsn1',
  accessKey: 'AK',
  secretKey: 'SK',
};

function exitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

function noServerTouched() {
  expect(vi.mocked(runCommandAsync)).not.toHaveBeenCalled();
  expect(vi.mocked(ssh.sshKubectl)).not.toHaveBeenCalled();
  expect(vi.mocked(ssh.sshRunScript)).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

describe('restore run(): no restorable base refuses before any stop', () => {
  for (const deployMode of ['compose', 'kubernetes']) {
    it(`${deployMode}: zero sentinels exits 1 naming the bucket, and nothing on the server runs`, async () => {
      envConfig = { deployMode, provider: 'hetzner', servers: [{ ip: '10.0.0.1' }] };
      const s3 = emptyS3();
      const errors: string[] = [];
      vi.spyOn(p.log, 'error').mockImplementation((m: string) => {
        errors.push(String(m));
      });
      const exit = exitSpy();
      await expect(
        run(['prod', '-y', '-source', 'latest', '-confirm', 'prod'], {
          resolveS3Config: async () => S3,
          createS3Client: () => s3,
        }),
      ).rejects.toThrow('process.exit(1)');
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors.join('\n')).toMatch(/no base backup/i);
      expect(errors.join('\n')).toContain('s3://myapp-backups/backups/myapp/prod/walg');
      expect(s3.sent).toEqual(['ListObjectsV2Command']);
      noServerTouched();
    });
  }

  it('-y with no backup credentials exits 1 naming the variables, before any stop', async () => {
    envConfig = { deployMode: 'compose', provider: 'hetzner', servers: [{ ip: '10.0.0.1' }] };
    const errors: string[] = [];
    vi.spyOn(p.log, 'error').mockImplementation((m: string) => {
      errors.push(String(m));
    });
    exitSpy();
    await expect(
      run(['prod', '-y', '-source', 'latest', '-confirm', 'prod'], {
        resolveS3Config: async () => null,
      }),
    ).rejects.toThrow('process.exit(1)');
    expect(errors.join('\n')).toContain('HETZNER_ACCESS_KEY');
    expect(errors.join('\n')).toContain('HETZNER_SECRET_KEY');
    noServerTouched();
  });
});

describe('restore run(): the real credential lookup with -y', () => {
  // Off a TTY a prompt would fail with assertInteractiveStdin's wording, not
  // this one: the message proves -y took the skipPrompts path.
  it('reads the env vars, never prompts, and exits 1 naming them when they are missing', async () => {
    // The real resolveS3Config: the backup bucket from .vibecarbon.json in the
    // cwd, the keys from the provider's env vars, skipPrompts from -y.
    envConfig = { deployMode: 'compose', provider: 'hetzner', servers: [{ ip: '10.0.0.1' }] };
    const projectDir = mkdtempSync(join(tmpdir(), 'vc-restore-creds-'));
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'myapp',
        environments: {
          prod: { ...envConfig, backupS3: { bucket: 'myapp-backups', region: 'fsn1' } },
        },
      }),
    );
    const saved = {
      HETZNER_ACCESS_KEY: process.env.HETZNER_ACCESS_KEY,
      HETZNER_SECRET_KEY: process.env.HETZNER_SECRET_KEY,
    };
    delete process.env.HETZNER_ACCESS_KEY;
    delete process.env.HETZNER_SECRET_KEY;
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const errors: string[] = [];
    vi.spyOn(p.log, 'error').mockImplementation((m: string) => {
      errors.push(String(m));
    });
    exitSpy();
    try {
      await expect(run(['prod', '-y', '-source', 'latest', '-confirm', 'prod'])).rejects.toThrow(
        'process.exit(1)',
      );
      expect(errors.join('\n')).toContain('HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY');
      noServerTouched();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('the runners refuse without a resolved base', () => {
  const s = { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
  const chosenSource = { kind: 's3' as const, name: 'latest' };

  it('runComposeRestore', async () => {
    await expect(
      runComposeRestore({
        s,
        chosenSource,
        envName: 'prod',
        projectName: 'myapp',
        serverIp: '10.0.0.1',
        sshKeyPath: keyPath,
        envConfig: { deployMode: 'compose' },
      } as never),
    ).rejects.toThrow(/resolved base backup/);
    noServerTouched();
  });

  it('runK8sRestore', async () => {
    await expect(
      runK8sRestore({
        s,
        chosenSource,
        envName: 'prod',
        serverIp: '10.0.0.1',
        sshKeyPath: keyPath,
        envConfig: { deployMode: 'kubernetes' },
      } as never),
    ).rejects.toThrow(/resolved base backup/);
    noServerTouched();
  });
});
