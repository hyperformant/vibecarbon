import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '@server/db/client';
import { checkDatabase } from '@server/routes/_internal/services-status';
import { dbTestsEnabled } from './_helpers';

/**
 * The admin Infrastructure page's PostgreSQL row. The app asks Postgres
 * `select 1` through its own connection, so the row says what the app sees:
 * up when the database answers, down when the query fails or hangs.
 */
describe.skipIf(!dbTestsEnabled)('services status: database check', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('reports PostgreSQL healthy when the real database answers select 1', async () => {
    const result = await checkDatabase();
    expect(result).toMatchObject({ name: 'PostgreSQL', container: 'db', status: 'healthy' });
    expect(result.error).toBeUndefined();
    expect(typeof result.latencyMs).toBe('number');
  });

  it('reports PostgreSQL unhealthy when the query throws, without echoing the error text', async () => {
    const failing = {
      execute: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 secret-detail');
      },
    };
    const result = await checkDatabase(failing as never);
    expect(result).toMatchObject({ name: 'PostgreSQL', container: 'db', status: 'unhealthy' });
    expect(result.error).toBe('Not reachable');
    expect(JSON.stringify(result)).not.toContain('secret-detail');
  });

  it('reports PostgreSQL unhealthy with a timeout when the query never answers', async () => {
    const hanging = { execute: () => new Promise(() => {}) };
    const result = await checkDatabase(hanging as never, 50);
    expect(result).toMatchObject({ status: 'unhealthy', error: 'Timeout' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(40);
  });
});
