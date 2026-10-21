/**
 * The planned-failover database write fence (HA-correctness Task 3, fix round 1).
 *
 * Stopping the app is only the outward signal. The guarantee behind planned
 * RPO 0 is the database itself: ALTER SYSTEM SET default_transaction_read_only
 * (a node-local file, never ALTER ROLE/DATABASE, which replicate and survive
 * the promote), read back applied, then every pre-fence client session
 * terminated. A basebackup of a fenced primary copies postgresql.auto.conf,
 * so the staged reseed strips the setting and the failover proves it is gone
 * before the promote.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(async () => ''),
}));

const ssh = await import('../../../src/lib/ssh.js');
const {
  assertStandbyNotWriteFenced,
  buildStagedBasebackupScript,
  fenceDatabaseWrites,
  k8sPsqlRunner,
  TERMINATE_CLIENT_BACKENDS_SQL,
  UNFENCE_SQL_HINT,
  unfenceDatabaseWrites,
  WRITE_FENCE_SETTING,
} = await import('../../../src/lib/deploy/replication.js');
const { waitForAppTierGone } = await import('../../../src/failover.js');

const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
};

/** A fake old primary: answers the fence's SQL and records it in order. */
function fakePrimary({
  settingAfterReload = 'on',
  terminated = '101=t,102=t',
  left = '0',
}: {
  settingAfterReload?: string;
  terminated?: string;
  left?: string;
} = {}) {
  const sql: string[] = [];
  let reloaded = false;
  const exec = vi.fn(async (q: string, _o?: { readWrite?: boolean }) => {
    sql.push(q);
    if (q === 'SELECT pg_reload_conf()') {
      reloaded = true;
      return 't';
    }
    if (q.startsWith('SELECT current_setting(')) return reloaded ? settingAfterReload : 'off';
    if (q === TERMINATE_CLIENT_BACKENDS_SQL) return terminated;
    if (q.includes('WHERE pid IN')) return left;
    return '';
  });
  return { exec, sql };
}

describe('fenceDatabaseWrites', () => {
  it('sets the read-only default by ALTER SYSTEM, reloads, reads it back, then terminates and proves the sessions gone', async () => {
    const { exec, sql } = fakePrimary();
    await expect(fenceDatabaseWrites({ exec, ...clock() })).resolves.toEqual({ terminated: 2 });
    expect(sql[0]).toBe(`ALTER SYSTEM SET ${WRITE_FENCE_SETTING} = on`);
    expect(sql[1]).toBe('SELECT pg_reload_conf()');
    expect(sql.indexOf(TERMINATE_CLIENT_BACKENDS_SQL)).toBeGreaterThan(
      sql.findIndex((q) => q.startsWith('SELECT current_setting(')),
    );
    expect(sql[sql.length - 1]).toBe(
      'SELECT count(*) FROM pg_stat_activity WHERE pid IN (101, 102)',
    );
  });

  it('never fences by role or database settings (they replicate and survive the promote)', async () => {
    const { exec, sql } = fakePrimary();
    await fenceDatabaseWrites({ exec, ...clock() });
    expect(sql.some((q) => /ALTER (ROLE|DATABASE|USER)/i.test(q))).toBe(false);
  });

  it('terminates only client backends and pg_cron job workers, never itself', () => {
    expect(TERMINATE_CLIENT_BACKENDS_SQL).toContain('pid <> pg_backend_pid()');
    expect(TERMINATE_CLIENT_BACKENDS_SQL).toContain(
      "backend_type IN ('client backend', 'pg_cron', 'pg_cron worker')",
    );
    expect(TERMINATE_CLIENT_BACKENDS_SQL).toContain('pg_terminate_backend(pid, 5000)');
    for (const t of ['walsender', 'checkpointer', 'background writer', 'walwriter', 'archiver']) {
      expect(TERMINATE_CLIENT_BACKENDS_SQL).not.toContain(t);
    }
  });

  it('throws at the deadline when the setting never reads back on, before terminating anything', async () => {
    const { exec, sql } = fakePrimary({ settingAfterReload: 'off' });
    const c = clock();
    await expect(
      fenceDatabaseWrites({ exec, deadlineMs: 2000, pollMs: 500, ...c }),
    ).rejects.toThrow(/did not read back default_transaction_read_only = on \(last read: off\)/);
    expect(sql).not.toContain(TERMINATE_CLIENT_BACKENDS_SQL);
  });

  it('throws when a terminated session is still there', async () => {
    const { exec } = fakePrimary({ terminated: '101=f', left: '1' });
    await expect(fenceDatabaseWrites({ exec, ...clock() })).rejects.toThrow(
      /1 client session\(s\) on the old primary outlived pg_terminate_backend/,
    );
  });

  it('an unreadable terminate result is not a fence', async () => {
    const { exec } = fakePrimary({ terminated: 'ERROR: permission denied' });
    await expect(fenceDatabaseWrites({ exec, ...clock() })).rejects.toThrow(
      /could not terminate the old primary's client sessions/,
    );
  });

  it('no client sessions: nothing to prove gone', async () => {
    const { exec, sql } = fakePrimary({ terminated: '' });
    await expect(fenceDatabaseWrites({ exec, ...clock() })).resolves.toEqual({ terminated: 0 });
    expect(sql.some((q) => q.includes('WHERE pid IN'))).toBe(false);
  });
});

describe('unfenceDatabaseWrites', () => {
  it('resets the setting from a read-write session, reloads and reads it back off', async () => {
    let reset = false;
    const exec = vi.fn(async (q: string, o?: { readWrite?: boolean }) => {
      if (q === `ALTER SYSTEM RESET ${WRITE_FENCE_SETTING}`) {
        expect(o?.readWrite).toBe(true);
        reset = true;
      }
      if (q.startsWith('SELECT current_setting(')) return reset ? 'off' : 'on';
      return '';
    });
    await expect(unfenceDatabaseWrites({ exec, ...clock() })).resolves.toBe(true);
  });

  it('never throws: an unprovable un-fence is false', async () => {
    const exec = vi.fn(async (q: string) => (q.startsWith('SELECT current_setting(') ? 'on' : ''));
    await expect(unfenceDatabaseWrites({ exec, deadlineMs: 1000, ...clock() })).resolves.toBe(
      false,
    );
    const throwing = vi.fn(async () => {
      throw new Error('ssh dropped');
    });
    await expect(unfenceDatabaseWrites({ exec: throwing, ...clock() })).resolves.toBe(false);
  });

  it('the manual un-fence hint nests inside a single-quoted ssh command and opens read-write', () => {
    expect(UNFENCE_SQL_HINT).not.toContain("'");
    expect(UNFENCE_SQL_HINT).toMatch(/^env PGOPTIONS="-c default_transaction_read_only=off" psql/);
    expect(UNFENCE_SQL_HINT).toContain('-c "ALTER SYSTEM RESET default_transaction_read_only"');
  });

  it('the k8s runner opens a read-write session with PGOPTIONS', async () => {
    await k8sPsqlRunner('10.0.0.1', '/k')('SELECT 1', { readWrite: true });
    const argv = vi.mocked(ssh.sshKubectl).mock.calls.at(-1)?.[2] as string[];
    expect(argv).toEqual(
      expect.arrayContaining(['env', `PGOPTIONS=-c ${WRITE_FENCE_SETTING}=off`]),
    );
    expect(argv.indexOf('env')).toBeLessThan(argv.indexOf('psql'));
  });
});

describe('the reseed never carries the fence into a promote', () => {
  it('the staged basebackup strips the fence from postgresql.auto.conf before the swap', () => {
    for (const swap of [true, false]) {
      const script = buildStagedBasebackupScript({
        replPassword: 'x',
        primaryHost: '10.99.0.1',
        swap,
        stagingDir: '/stage',
      });
      const strip = `sed -i '/^[[:space:]]*${WRITE_FENCE_SETTING}[[:space:]]*=/d' /stage/postgresql.auto.conf`;
      expect(script).toContain(strip);
      // After pg_basebackup wrote the file, before the chown and any swap.
      expect(script.indexOf(strip)).toBeGreaterThan(script.indexOf('pg_basebackup'));
      expect(script.indexOf(strip)).toBeLessThan(
        script.indexOf('chown -R postgres:postgres /stage'),
      );
    }
  });

  it('assertStandbyNotWriteFenced reads the settings files and refuses a carried fence', async () => {
    const q: string[] = [];
    const clean = async (sql: string) => {
      q.push(sql);
      return '0\n';
    };
    await expect(assertStandbyNotWriteFenced({ exec: clean })).resolves.toBeUndefined();
    expect(q[0]).toBe(
      `SELECT count(*) FROM pg_file_settings WHERE name = '${WRITE_FENCE_SETTING}'`,
    );
    await expect(assertStandbyNotWriteFenced({ exec: async () => '1' })).rejects.toThrow(
      /carries the old primary's write fence .* would promote read-only/,
    );
    await expect(assertStandbyNotWriteFenced({ exec: async () => '' })).rejects.toThrow(
      /could not read the reseeded standby's settings files/,
    );
  });
});

describe('waitForAppTierGone (a quiesce is proven, not assumed)', () => {
  const list = [
    { name: 'app', namespace: 'vibecarbon', replicas: 2 },
    { name: 'gone', namespace: 'vibecarbon', replicas: 1 },
  ];
  const kubectlWith = (podsSeq: string[]) => {
    let i = 0;
    return vi.fn(async (_ip: string, _k: string, argv: string[]) => {
      if (argv[1] === 'deployment') {
        if (argv[2] === 'gone')
          throw new Error('Error from server (NotFound): deployments.apps "gone" not found');
        return '{"app.kubernetes.io/name":"app"}';
      }
      return podsSeq[Math.min(i++, podsSeq.length - 1)];
    });
  };

  it('waits until the quiesced pods are gone, and skips a Deployment that does not exist', async () => {
    const kubectl = kubectlWith(['pod/app-1', 'pod/app-1', '']);
    const c = clock();
    await expect(waitForAppTierGone('10.0.0.1', '/k', list, { kubectl, ...c })).resolves.toEqual({
      ok: true,
      remaining: [],
    });
    const podCalls = kubectl.mock.calls.filter((call) => call[2][1] === 'pods');
    expect(podCalls[0][2]).toEqual([
      'get',
      'pods',
      '-n',
      'vibecarbon',
      '-l',
      'app.kubernetes.io/name=app',
      '-o',
      'name',
    ]);
    expect(c.sleep).toHaveBeenCalledTimes(2);
  });

  it('a pod still there at the deadline is not quiesced', async () => {
    const kubectl = kubectlWith(['pod/app-1']);
    await expect(
      waitForAppTierGone('10.0.0.1', '/k', list, {
        kubectl,
        deadlineMs: 9000,
        pollMs: 3000,
        ...clock(),
      }),
    ).resolves.toEqual({ ok: false, remaining: ['app'] });
  });

  it('an unreadable Deployment is not quiesced', async () => {
    const kubectl = vi.fn(async () => {
      throw new Error('Unable to connect to the server');
    });
    const r = await waitForAppTierGone('10.0.0.1', '/k', list, { kubectl, ...clock() });
    expect(r.ok).toBe(false);
    expect(r.remaining[0]).toMatch(/app \(unreadable/);
  });
});
