/**
 * The deploy converges the LIVE wal-g role file, not only the intent.
 *
 * db-guard.sh applies the intent ConfigMap (vibecarbon-db-role) on every db
 * container start, but a warm redeploy that does not restart the db would
 * leave the file as it was. So applyK3sManifests' db wait (awaitDb) ends with
 * writeDeployWalgRole: setK8sWalgRole with requireLive, through a
 * local-kubectl adapter, after postgres accepts and before the wal-g audit
 * (verifyWalgBackups in deployK3s), so the audit reads the role this deploy set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeDeployWalgRole } from '../../../src/lib/deploy/k8s/k3s.js';

const ROOT = join(__dirname, '../../..');

/** `kubectl get pod db-0 -o json` for a pod whose db container mounts the role dir. */
function podWithRoleMount() {
  return JSON.stringify({
    spec: {
      containers: [
        {
          name: 'db',
          volumeMounts: [
            { name: 'data', mountPath: '/var/lib/postgresql/data', subPath: 'postgres-data' },
            { name: 'data', mountPath: '/var/lib/vibecarbon/role', subPath: 'vibecarbon-role' },
          ],
        },
      ],
    },
  });
}

describe('writeDeployWalgRole', () => {
  it('writes the live role with requireLive after the rollout, through setK8sWalgRole', async () => {
    const calls: string[] = [];
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      calls.push(argv.join(' '));
      if (argv.includes('get')) return podWithRoleMount();
      if (argv.includes('exec')) return 'WALG_ROLE_FILE=primary';
      return '';
    });
    await writeDeployWalgRole({ kubectl, role: 'primary' });
    expect(calls[0]).toContain('apply -f -');
    expect(calls.some((c) => c.includes('exec') && c.includes('/var/lib/vibecarbon/role'))).toBe(
      true,
    );
  });

  it('a live write that does not read back fails the deploy', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? podWithRoleMount() : argv.includes('exec') ? 'WALG_ROLE_FILE=' : '',
    );
    await expect(writeDeployWalgRole({ kubectl, role: 'primary' })).rejects.toThrow();
  });

  it('a pod without the role mount fails the deploy and names the env', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? JSON.stringify({ spec: { containers: [{ name: 'db' }] } }) : '',
    );
    await expect(
      writeDeployWalgRole({ kubectl, role: 'standby', envName: 'prod' }),
    ).rejects.toThrow(/vibecarbon deploy prod/);
  });

  it('awaitDb runs it after the rollout and postgres readiness, before the wal-g audit', () => {
    const src = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const awaitDb = src.slice(src.indexOf('const awaitDb = async () => {'));
    const body = awaitDb.slice(0, awaitDb.indexOf('\n  };'));
    expect(body.indexOf('awaitPostgresAccepting(')).toBeGreaterThan(-1);
    expect(body.indexOf('awaitPostgresAccepting(')).toBeLessThan(
      body.indexOf('writeDeployWalgRole('),
    );
    expect(src.indexOf('writeDeployWalgRole(', src.indexOf('const awaitDb'))).toBeLessThan(
      src.indexOf('verifyWalgBackups({', src.indexOf('const awaitDb')),
    );
  });
});
