/**
 * The write fence against a REAL Postgres with a live client session.
 *
 * The bug this pins: TERMINATE_CLIENT_BACKENDS_SQL built each entry with
 * `ok::text`, and a boolean cast to text is `true`/`false`, while the parser
 * expected psql's own `t`/`f`. Unit tests fed the parser `4242=t`, a shape the
 * SQL never produced, so the fence passed every test and failed every real
 * planned failover and compose-ha scale whose primary had a client session
 * (DO compose-ha scale, 2026-11-04: "could not terminate the old primary's
 * client sessions (got: 137=true)").
 */
import { execFileSync, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fenceDatabaseWrites } from '../../../src/lib/deploy/replication.js';

const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const NAME = `vctest-fence-${process.pid}`;
const run = (args: string[]) => execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe' });
const psql = (sql: string) => run(['exec', NAME, 'psql', '-U', 'postgres', '-tAc', sql]).trim();

describeDocker('the write fence against a real Postgres', () => {
  let session: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    run(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=fence', 'postgres:17-alpine']);
    for (let i = 0; i < 60; i++) {
      try {
        if (psql('SELECT 1') === '1') break;
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // A client session the fence must end: it sleeps inside an open session.
    session = spawn(
      'docker',
      ['exec', NAME, 'psql', '-U', 'postgres', '-c', 'SELECT pg_sleep(600)'],
      {
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 30; i++) {
      const n = psql(
        "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND query LIKE '%pg_sleep(600)%' AND pid <> pg_backend_pid()",
      );
      if (n === '1') break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 120_000);

  afterAll(() => {
    session?.kill();
    try {
      run(['rm', '-f', '-v', NAME]);
    } catch {
      // already gone
    }
  });

  it('fences writes and ends the live client session', async () => {
    const result = await fenceDatabaseWrites({ exec: async (sql: string) => psql(sql) });
    expect(result.terminated).toBeGreaterThanOrEqual(1);
    expect(psql("SELECT current_setting('default_transaction_read_only')")).toBe('on');
    expect(
      psql(
        "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND query LIKE '%pg_sleep(600)%' AND pid <> pg_backend_pid()",
      ),
    ).toBe('0');
  }, 60_000);
});
