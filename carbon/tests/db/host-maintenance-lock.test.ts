import { describe, expect, it } from 'vitest';
import { dbTestsEnabled } from './_helpers';

/**
 * The daily restart email takes a session advisory lock on a dedicated pool
 * client so only one replica sends. Two concurrent attempts on the real pool
 * must see exactly one 'locked'.
 */
describe.skipIf(!dbTestsEnabled)('withHostMaintenanceLock (real Postgres)', () => {
  it('lets exactly one of two concurrent callers in', async () => {
    const { withHostMaintenanceLock } = await import('@server/jobs/host-maintenance-email');
    const { pool } = await import('@server/db/client');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = withHostMaintenanceLock(async () => {
      await gate;
      return 'ran';
    });
    // Let the first caller take the lock before the second tries.
    await new Promise((r) => setTimeout(r, 300));
    const second = await withHostMaintenanceLock(async () => 'ran');
    release();
    expect(await first).toBe('ran');
    expect(second).toBe('locked');
    // Released afterwards: a third caller gets in.
    expect(await withHostMaintenanceLock(async () => 'ran')).toBe('ran');
    await pool.end();
  });
});
