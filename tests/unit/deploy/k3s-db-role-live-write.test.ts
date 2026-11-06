/**
 * The deploy converges the LIVE wal-g role file, not only the intent.
 *
 * db-guard.sh applies the intent ConfigMap (vibecarbon-db-role) on every db
 * container start, but a warm redeploy that does not restart the db would
 * leave the file as it was. So deployK3s runs writeDeployWalgRole on every
 * deploy, outside the k3s-apply skip gate (a skipped apply first reads the db
 * pod's Ready condition), through a local-kubectl adapter and before the wal-g
 * audit (verifyWalgBackups), so the audit reads the role this deploy set. When
 * the ConfigMap already proves the role it does not exec at all
 * (k8s-walg-role-record.test.ts).
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
  it('writes the intent and the live role through setK8sWalgRole', async () => {
    const calls: string[] = [];
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      calls.push(argv.join(' '));
      if (argv.includes('get')) return podWithRoleMount();
      if (argv.includes('exec')) return 'WALG_ROLE_FILE=primary';
      return '';
    });
    await writeDeployWalgRole({ kubectl, role: 'primary' });
    const apply = calls.findIndex((c) => c.includes('apply -f -'));
    const exec = calls.findIndex(
      (c) => c.includes('exec') && c.includes('/var/lib/vibecarbon/role'),
    );
    expect(apply).toBeGreaterThan(-1);
    expect(exec).toBeGreaterThan(apply);
  });

  it('a live write that does not read back fails the deploy', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? podWithRoleMount() : argv.includes('exec') ? 'WALG_ROLE_FILE=' : '',
    );
    await expect(writeDeployWalgRole({ kubectl, role: 'primary' })).rejects.toThrow();
  });

  it('a pod without the role mount fails the deploy with a deploy-specific error', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? JSON.stringify({ spec: { containers: [{ name: 'db' }] } }) : '',
    );
    const err = await writeDeployWalgRole({ kubectl, role: 'standby', envName: 'prod' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(
      'the db rollout did not give db-0 the wal-g role mount (/var/lib/vibecarbon/role); ' +
        'check the db StatefulSet template and `kubectl -n vibecarbon get pod db-0 -o yaml`',
    );
    // This IS the deploy: telling the operator to run one would be circular.
    expect(err.message).not.toContain('vibecarbon deploy');
  });

  it('the other reasons keep their detail', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) => {
      if (argv.includes('get')) return podWithRoleMount();
      if (argv.includes('exec')) {
        throw Object.assign(new Error('exec failed: disk full'), {
          stderr: '[walg-role] could not write the wal-g role in /var/lib/vibecarbon/role\n',
        });
      }
      return '';
    });
    await expect(writeDeployWalgRole({ kubectl, role: 'primary' })).rejects.toThrow(
      /could not set the wal-g role to primary on db-0 \(write-failed\): exec failed: disk full/,
    );
  });

  it('an unreadable read-back names read-back-mismatch', async () => {
    const kubectl = vi.fn(async (_ip: string, argv: string[]) =>
      argv.includes('get') ? podWithRoleMount() : argv.includes('exec') ? 'WALG_ROLE_FILE=' : '',
    );
    await expect(writeDeployWalgRole({ kubectl, role: 'primary' })).rejects.toThrow(
      /\(read-back-mismatch\)/,
    );
  });

  it('deployK3s runs it on EVERY deploy: outside the k3s-apply skip gate, before the wal-g audit', () => {
    const src = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    const deploy = src.slice(src.indexOf('async function deployK3sSteps('));
    const gate = deploy.indexOf('if (!skipApply) {');
    // The gate's else branch closes it; the call sits after the whole if/else.
    const gateEnd = deploy.indexOf('\n  }\n', deploy.indexOf('} else {', gate));
    const call = deploy.indexOf('writeDeployWalgRole(');
    const audit = deploy.indexOf('verifyWalgBackups({');
    expect(gate).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gate);
    expect(call).toBeGreaterThan(gateEnd);
    expect(call).toBeLessThan(audit);
    // A skipped apply waited for no db: the pod must be Ready before the write.
    const between = deploy.slice(gateEnd, call);
    expect(between).toMatch(/if \(skipApply\)[\s\S]*awaitDbPodReady\(/);
    // And applyK3sManifests' awaitDb no longer writes it (one write per deploy).
    const awaitDb = src.slice(src.indexOf('const awaitDb = async () => {'));
    expect(awaitDb.slice(0, awaitDb.indexOf('\n  };'))).not.toContain('writeDeployWalgRole(');
  });
});
