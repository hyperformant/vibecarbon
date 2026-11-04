/**
 * The pre-destroy backup is handed the key the deploy wrote.
 *
 * Real infra, DigitalOcean k8s, 2026-11-04: `vibecarbon destroy d3` stopped with
 * "SSH key not found: .vibecarbon/deploy_key_d3" because a single-cluster k8s
 * deploy had written `.vibecarbon/ssh-d3` and destroy hand-built the other
 * name. Every mode now writes through sshKeyPathFor; this runs the real k8s key
 * writer and then the destroy flow's own backup options against the same dir.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/command.js')>();
  const { writeFileSync: write } = await import('node:fs');
  return {
    ...actual,
    runCommandAsync: vi.fn(async (args: string[]) => {
      const keyPath = args[args.indexOf('-f') + 1];
      write(keyPath, 'fake-private-key\n');
      write(`${keyPath}.pub`, 'ssh-ed25519 AAAAfake vibecarbon\n');
      return '';
    }),
  };
});

// @ts-expect-error JS module without types
const { preDestroyBackup, preDestroyBackupOptions } = await import('../../../src/destroy.js');
const { ensureSshKey } = await import('../../../src/lib/deploy/k8s/k3s.js');
const { sshKeyPathFor } = await import('../../../src/lib/ssh.js');

const k8s = {
  deployMode: 'kubernetes',
  servers: [{ name: 'app-d3', role: 'master', ip: '10.0.0.7' }],
};

describe('pre-destroy backup on a single-cluster k8s env', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'predestroy-key-'));
    mkdirSync(join(dir, '.vibecarbon'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('receives the helper path, finds the deployed key, and runs the backup', async () => {
    const { privateKeyPath } = await ensureSshKey(dir, 'd3');
    const options = preDestroyBackupOptions({
      envConfig: k8s,
      envName: 'd3',
      projectName: 'app',
      cwd: dir,
      args: { yes: true, purgeBackups: false, force: false },
    });
    expect(options.sshKeyPath).toBe(sshKeyPathFor('d3', dir));
    expect(options.sshKeyPath).toBe(privateKeyPath);

    const triggerBackupJob = vi.fn(async () => ({ result: 'pushed', name: 'base_k' }));
    const exit = vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    });
    const log = { info() {}, warn() {}, error: vi.fn(), success() {}, message() {} };
    await preDestroyBackup(options, {
      triggerBackupJob,
      exit,
      log,
      spinner: () => ({ start() {}, stop() {} }),
    });
    expect(log.error).not.toHaveBeenCalled();
    expect(triggerBackupJob).toHaveBeenCalledWith('10.0.0.7', privateKeyPath);
  });
});
