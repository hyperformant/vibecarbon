/**
 * The pre-destroy backup acts on what the backup reports.
 *
 * Before: destroy offered a backup only off -y, ran it on compose only (a k8s
 * env got a spinner and no backup), and a failed or skipped backup printed
 * "Continuing with destroy..." and deleted the servers anyway. Now the backup
 * runs on the primary resolvePrimary names, k8s triggers the backup Job, -y
 * backs up by default while backups are kept, and a backup that fails or
 * reports `skipped` stops the destroy unless -force.
 */
import { describe, expect, it, vi } from 'vitest';

const { preDestroyBackup } = await import('../../../src/destroy.js');

const PRIMARY = '10.2.0.9';
const RETIRED = '10.2.0.1';

/** k8s-ha after a failover: servers[0] is the retired master. */
const k8sHa = () => ({
  deployMode: 'kubernetes',
  ha: { enabled: true, primary: { masterIp: PRIMARY }, standby: { masterIp: RETIRED } },
  servers: [
    { name: 'app-prod-primary', role: 'standby', ip: RETIRED },
    { name: 'app-prod-standby', role: 'primary', ip: PRIMARY },
  ],
});

const compose = () => ({ deployMode: 'compose', servers: [{ ip: '10.0.0.5' }] });

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

function harness(overrides: Record<string, unknown> = {}) {
  const logs: Array<[string, string]> = [];
  const log = {
    info: (m: string) => logs.push(['info', m]),
    warn: (m: string) => logs.push(['warn', m]),
    error: (m: string) => logs.push(['error', m]),
    success: (m: string) => logs.push(['success', m]),
    message: (m: string) => logs.push(['message', m]),
  };
  const deps = {
    log,
    spinner: () => ({ start() {}, stop: (m: string) => logs.push(['stop', m]) }),
    exit: (code: number) => {
      throw new Exit(code);
    },
    keyExists: () => true,
    confirm: vi.fn(async () => true),
    backupCompose: vi.fn(async () => ({ result: 'pushed', name: 'base_c' })),
    triggerBackupJob: vi.fn(async () => ({ result: 'pushed', name: 'base_k' })),
    ...overrides,
  };
  return { deps, logs };
}

const opts = (envConfig: object, extra: Record<string, unknown> = {}) => ({
  envConfig,
  envName: 'prod',
  projectName: 'app',
  sshKeyPath: '/k',
  yes: true,
  purge: false,
  force: false,
  ...extra,
});

describe('preDestroyBackup', () => {
  it('k8s with -y triggers the backup Job on the primary resolvePrimary names', async () => {
    const { deps, logs } = harness();
    await preDestroyBackup(opts(k8sHa()), deps);
    expect(deps.triggerBackupJob).toHaveBeenCalledWith(PRIMARY, '/k');
    expect(deps.backupCompose).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(logs).toContainEqual(['stop', 'base backup pushed: base_k']);
  });

  it('compose with -y backs up through backupCompose', async () => {
    const { deps } = harness();
    await preDestroyBackup(opts(compose()), deps);
    expect(deps.backupCompose).toHaveBeenCalledWith('10.0.0.5', '/k', 'app', {
      retain: undefined,
    });
  });

  it('a skipped backup stops the destroy with the reason and the override', async () => {
    const { deps, logs } = harness({
      triggerBackupJob: vi.fn(async () => ({ result: 'skipped', reason: 'standby-role' })),
    });
    await expect(preDestroyBackup(opts(k8sHa()), deps)).rejects.toThrow(new Exit(1));
    expect(logs).toContainEqual([
      'error',
      'backup skipped (standby-role); destroy stopped; rerun with -force to destroy anyway',
    ]);
  });

  it('-force continues past a skip, saying so', async () => {
    const { deps, logs } = harness({
      triggerBackupJob: vi.fn(async () => ({ result: 'skipped', reason: 'in-recovery' })),
    });
    await preDestroyBackup(opts(k8sHa(), { force: true }), deps);
    expect(logs.some(([k, m]) => k === 'warn' && /backup skipped \(in-recovery\)/.test(m))).toBe(
      true,
    );
  });

  it('a failed backup stops the destroy with its first line as the cause', async () => {
    const { deps, logs } = harness({
      backupCompose: vi.fn(async () => {
        throw new Error('Command failed: ssh …\nERROR: permission denied');
      }),
    });
    await expect(preDestroyBackup(opts(compose()), deps)).rejects.toThrow(new Exit(1));
    expect(logs).toContainEqual([
      'error',
      'backup failed (Command failed: ssh …); destroy stopped; rerun with -force to destroy anyway',
    ]);
  });

  it('a pushed base whose retention failed still counts as backed up, with a warning', async () => {
    const { deps, logs } = harness({
      backupCompose: vi.fn(async () => ({
        result: 'pushed',
        name: 'base_c',
        retentionError: 'retention failed after pushing base_c: AccessDenied',
      })),
    });
    await preDestroyBackup(opts(compose()), deps);
    expect(logs.some(([k, m]) => k === 'warn' && m.includes('AccessDenied'))).toBe(true);
  });

  it('an ambiguous primary stops the destroy (no silent "backed up"), and -force overrides', async () => {
    const env = k8sHa();
    env.servers[0].role = 'primary'; // two claim primary
    const { deps, logs } = harness();
    await expect(preDestroyBackup(opts(env), deps)).rejects.toThrow(new Exit(1));
    const err = logs.find(([k]) => k === 'error')?.[1] ?? '';
    expect(err).toMatch(
      /^backup skipped \(the primary is unknown: prod: .*\); destroy stopped; rerun with -force to destroy anyway$/,
    );
    expect(deps.triggerBackupJob).not.toHaveBeenCalled();

    const forced = harness();
    await preDestroyBackup(opts(env, { force: true }), forced.deps);
    expect(forced.deps.triggerBackupJob).not.toHaveBeenCalled();
  });

  it('a missing deploy key is a failed backup, not a silent skip', async () => {
    const { deps, logs } = harness({ keyExists: () => false });
    await expect(preDestroyBackup(opts(compose()), deps)).rejects.toThrow(new Exit(1));
    expect(logs).toContainEqual([
      'error',
      'backup failed (SSH key not found: /k); destroy stopped; rerun with -force to destroy anyway',
    ]);
  });

  it('-purge deletes the backups, so no backup is taken', async () => {
    const { deps } = harness();
    await preDestroyBackup(opts(compose(), { purge: true }), deps);
    expect(deps.backupCompose).not.toHaveBeenCalled();
  });

  it('interactive: asks first (default yes); a "no" destroys without a backup', async () => {
    const { deps } = harness({ confirm: vi.fn(async () => false) });
    await preDestroyBackup(opts(compose(), { yes: false }), deps);
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }));
    expect(deps.backupCompose).not.toHaveBeenCalled();

    const yes = harness();
    await preDestroyBackup(opts(compose(), { yes: false }), yes.deps);
    expect(yes.deps.backupCompose).toHaveBeenCalled();
  });

  it('nothing deployed: no server, nothing to back up', async () => {
    const { deps } = harness();
    await preDestroyBackup(opts({ deployMode: 'compose', servers: [] }), deps);
    expect(deps.backupCompose).not.toHaveBeenCalled();
  });
});
