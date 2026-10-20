/**
 * Every e2e mode, at every verify step that runs the database checks, must hand
 * runAppFunctionalChecks a real SSH handle: an ip AND an sshKeyPath, on the
 * node that fronts the database.
 *
 * The 2026-10-19 Hetzner k8s run failed db_schema, db_write_roundtrip,
 * db_migrations_applied, db_cron_jobs and db_server_config with
 * "Cannot reach the database: no sshKeyPath (serverIp present)" while compose
 * passed all five. A k8s single-cluster deploy writes its key to
 * `.vibecarbon/ssh-<env>` (deployK3s → ensureSshKey); the harness's
 * getSshKeyPath probed only `deploy_key_<env>` (what compose, compose-HA and
 * k8s-HA write) and a `ssh_key` file nothing writes, so on k8s it returned
 * null at every step.
 *
 * Each fixture is built the way the deploy builds it: the k8s key file comes
 * from the real ensureSshKey (ssh-keygen stubbed), and the `deploy_key_<env>`
 * name the other modes use is pinned against the deploy source below, so a
 * renamed key file fails here rather than on live infra. The resolution chain
 * is the verify block's own: getServerIps + getSshKeyPath →
 * resolveSshCheckMasterIp → buildDbHandle.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/command.js')>();
  const { writeFileSync: write } = await import('node:fs');
  // ssh-keygen stand-in: write both halves at the `-f` path the deploy chose.
  const fakeKeygen = (args: string[]) => {
    const keyPath = args[args.indexOf('-f') + 1];
    write(keyPath, 'fake-private-key\n');
    write(`${keyPath}.pub`, 'ssh-ed25519 AAAAfake vibecarbon\n');
    return '';
  };
  return {
    ...actual,
    runCommandAsync: vi.fn(async (args: string[]) => fakeKeygen(args)),
  };
});

import { ensureSshKey } from '../../../src/lib/deploy/k8s/k3s.js';
import { buildDbHandle, resolveSshCheckMasterIp } from '../../e2e/checks/app-functional.js';
import type { ReplTarget } from '../../e2e/checks/replication.js';
import type { DeployMode, StepName } from '../../e2e/scenarios/types.js';
import { getServerIps, getSshKeyPath } from '../../e2e/utils/ssh.js';

const ENV = 'e2e-x1';
const PROJECT = 'testapp';

const PRIMARY = '10.0.0.1';
const PRIMARY_DB = '10.0.0.2';
const STANDBY = '10.0.0.11';
const STANDBY_DB = '10.0.0.12';
const WORKER = '10.0.0.3';

const srcFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url)), 'utf8');

/** Write `.vibecarbon/deploy_key_<env>` the way generateSSHKeyPair leaves it. */
function writeDeployKey(dir: string): void {
  mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  writeFileSync(join(dir, '.vibecarbon', `deploy_key_${ENV}`), 'fake-private-key\n');
  writeFileSync(join(dir, '.vibecarbon', `deploy_key_${ENV}.pub`), 'ssh-ed25519 AAAAfake\n');
}

type EnvConfig = Record<string, unknown>;

interface ModeFixture {
  mode: DeployMode;
  /** Writes the key file exactly where this mode's deploy writes it. */
  writeKey: (dir: string) => Promise<void>;
  /** .vibecarbon.json environment entry as the deploy persists it. */
  deployed: (provider: string) => EnvConfig;
  /** The same entry after `vibecarbon failover` (HA modes only). */
  failedOver?: (provider: string) => EnvConfig;
  /** The node the db checks must run on before failover. */
  dbHost: string;
}

const MODES: ModeFixture[] = [
  {
    mode: 'compose',
    writeKey: async (dir) => writeDeployKey(dir),
    deployed: (provider) => ({
      provider,
      region: 'r1',
      servers: [{ name: 'master', ip: PRIMARY, region: 'r1' }],
    }),
    dbHost: PRIMARY,
  },
  {
    mode: 'compose-ha',
    writeKey: async (dir) => writeDeployKey(dir),
    deployed: (provider) => ({
      provider,
      region: 'r1',
      secondaryRegion: 'r2',
      ha: { enabled: true, failoverRegion: 'r2' },
      servers: [
        { name: 'primary', ip: PRIMARY, region: 'r1' },
        { name: 'standby', ip: STANDBY, region: 'r2' },
      ],
    }),
    // failoverComposeHA flips `role` in place; order and names stay.
    failedOver: (provider) => ({
      provider,
      region: 'r2',
      secondaryRegion: 'r1',
      ha: { enabled: true, failoverRegion: 'r1' },
      servers: [
        { name: 'primary', ip: PRIMARY, role: 'standby', region: 'r1' },
        { name: 'standby', ip: STANDBY, role: 'primary', region: 'r2' },
      ],
    }),
    dbHost: PRIMARY,
  },
  {
    mode: 'k8s',
    // The real deploy-side writer, so the filename is the deploy's own.
    writeKey: async (dir) => {
      await ensureSshKey(dir, ENV);
    },
    deployed: (provider) => ({
      provider,
      region: 'r1',
      servers: [
        { name: 'master', ip: PRIMARY, dbIp: PRIMARY_DB, region: 'r1', role: 'master' },
        { name: 'db', ip: PRIMARY_DB, region: 'r1', role: 'db' },
        { name: 'worker-1', ip: WORKER, region: 'r1', role: 'worker' },
      ],
    }),
    // psql runs as `kubectl exec` from the master, never on the db node.
    dbHost: PRIMARY,
  },
  {
    mode: 'k8s-ha',
    writeKey: async (dir) => writeDeployKey(dir),
    deployed: (provider) => ({
      provider,
      region: 'r1',
      secondaryRegion: 'r2',
      ha: {
        enabled: true,
        failoverRegion: 'r2',
        primary: { masterIp: PRIMARY, dbIp: PRIMARY_DB, region: 'r1' },
        standby: { masterIp: STANDBY, dbIp: STANDBY_DB, region: 'r2' },
      },
      servers: [
        { name: 'primary', ip: PRIMARY, dbIp: PRIMARY_DB, region: 'r1' },
        { name: 'standby', ip: STANDBY, dbIp: STANDBY_DB, region: 'r2' },
      ],
    }),
    // swapHaRoles swaps ha.primary/ha.standby wholesale; servers[] untouched.
    failedOver: (provider) => ({
      provider,
      region: 'r2',
      secondaryRegion: 'r1',
      replication: 'degraded',
      degraded: true,
      ha: {
        enabled: true,
        failoverRegion: 'r1',
        primary: { masterIp: STANDBY, dbIp: STANDBY_DB, region: 'r2' },
        standby: { masterIp: PRIMARY, dbIp: PRIMARY_DB, region: 'r1' },
      },
      servers: [
        { name: 'primary', ip: PRIMARY, dbIp: PRIMARY_DB, region: 'r1' },
        { name: 'standby', ip: STANDBY, dbIp: STANDBY_DB, region: 'r2' },
      ],
    }),
    dbHost: PRIMARY,
  },
];

const PROVIDERS = ['hetzner', 'digitalocean'] as const;

/** The verify block's own resolution chain (_run-lifecycle.ts runVerificationChecks). */
function resolveDbHandle(dir: string, mode: DeployMode, stepName: StepName): ReplTarget | string {
  const serverIps = getServerIps(dir, ENV);
  const sshKeyPath = getSshKeyPath(dir, ENV);
  const ip = resolveSshCheckMasterIp(serverIps, {
    stepName,
    mode,
    projectDir: dir,
    envPrefix: ENV,
  });
  return buildDbHandle(ip, sshKeyPath, { mode, projectName: PROJECT });
}

function writeConfig(dir: string, env: EnvConfig): void {
  writeFileSync(
    join(dir, '.vibecarbon.json'),
    JSON.stringify({ projectName: PROJECT, environments: { [ENV]: env } }),
  );
}

describe('the deploy writes each mode key where the harness looks', () => {
  it('compose and compose-ha deploys write .vibecarbon/deploy_key_<env>', () => {
    const orchestrator = srcFile('lib/deploy/orchestrator.js');
    const writes = orchestrator.match(
      /const sshKeyPath = join\(process\.cwd\(\), '\.vibecarbon', `deploy_key_\$\{environment\}`\);/g,
    );
    // One for the compose branch, one for the compose-ha branch.
    expect(writes?.length).toBe(2);
  });

  it('the k8s-ha deploy writes the shared .vibecarbon/deploy_key_<env>', () => {
    expect(srcFile('lib/deploy/effects/k8s-ha.js')).toMatch(
      /sharedSshKeyPath = join\(process\.cwd\(\), '\.vibecarbon', `deploy_key_\$\{options\.environment\}`\);/,
    );
  });

  it('the k8s single-cluster deploy writes .vibecarbon/ssh-<env>', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-handle-k8s-key-'));
    try {
      const { privateKeyPath } = await ensureSshKey(dir, ENV);
      expect(privateKeyPath).toBe(join(dir, '.vibecarbon', `ssh-${ENV}`));
      expect(getSshKeyPath(dir, ENV)).toBe(privateKeyPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.each(PROVIDERS)('db handle per mode on %s', (provider) => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `db-handle-${provider}-`));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe.each(MODES)('$mode', (fixture) => {
    const preFailoverSteps: StepName[] = ['verify-deploy', 'verify-restore'];

    it.each(preFailoverSteps)(
      '%s resolves an ip and an sshKeyPath on the primary',
      async (step) => {
        await fixture.writeKey(dir);
        writeConfig(dir, fixture.deployed(provider));

        const handle = resolveDbHandle(dir, fixture.mode, step);

        expect(handle, `db handle missing: ${String(handle)}`).toEqual({
          ip: fixture.dbHost,
          sshKeyPath: expect.stringContaining(join(dir, '.vibecarbon')),
          mode: fixture.mode,
          projectName: PROJECT,
          label: 'primary',
        });
      },
    );

    if (fixture.failedOver) {
      const failedOver = fixture.failedOver;
      it('verify-failover resolves the PROMOTED primary, with an sshKeyPath', async () => {
        await fixture.writeKey(dir);
        writeConfig(dir, failedOver(provider));

        const handle = resolveDbHandle(dir, fixture.mode, 'verify-failover');

        expect(typeof handle, `db handle missing: ${String(handle)}`).toBe('object');
        expect((handle as ReplTarget).ip).toBe(STANDBY);
        expect((handle as ReplTarget).sshKeyPath).toContain(join(dir, '.vibecarbon'));
      });
    }

    it('reports the missing key, not a silent pass, when no key file exists', () => {
      writeConfig(dir, fixture.deployed(provider));

      expect(resolveDbHandle(dir, fixture.mode, 'verify-deploy')).toBe(
        'no sshKeyPath (serverIp present)',
      );
    });
  });
});

describe('getSshKeyPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-handle-keypath-'));
    mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers deploy_key_<env> when both conventions are present', () => {
    writeFileSync(join(dir, '.vibecarbon', `deploy_key_${ENV}`), 'k\n');
    writeFileSync(join(dir, '.vibecarbon', `ssh-${ENV}`), 'k\n');
    expect(getSshKeyPath(dir, ENV)).toBe(join(dir, '.vibecarbon', `deploy_key_${ENV}`));
  });

  it('never matches another environment key', () => {
    writeFileSync(join(dir, '.vibecarbon', 'ssh-other'), 'k\n');
    writeFileSync(join(dir, '.vibecarbon', 'deploy_key_other'), 'k\n');
    expect(getSshKeyPath(dir, ENV)).toBeNull();
  });

  it('returns null for a project with no .vibecarbon directory', () => {
    rmSync(join(dir, '.vibecarbon'), { recursive: true, force: true });
    expect(getSshKeyPath(dir, ENV)).toBeNull();
  });
});
