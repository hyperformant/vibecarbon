import { describe, expect, it } from 'vitest';
import { buildMigrateScript } from '../../../carbon/scripts/db-migrate.js';

describe('buildMigrateScript', () => {
  const script = buildMigrateScript();

  it('suppresses notices and per-statement noise via the quiet psql invocation', () => {
    expect(script).toContain('client_min_messages=warning');
    expect(script).toContain('-q');
    expect(script).toContain('>/dev/null');
  });

  it('stops on the first error so a broken migration aborts startup', () => {
    expect(script).toContain('ON_ERROR_STOP=1');
    expect(script).toContain('set -e');
  });

  it('applies each migration file atomically so a mid-file failure leaves no partial schema', () => {
    expect(script).toContain('--single-transaction');
  });

  it('runs every migration then the super-admin SQL, echoing one line per file', () => {
    expect(script).toContain('/migrations/*.sql');
    expect(script).toContain('/tmp/super-admin.sql');
    expect(script).toMatch(/✓.*basename|✓ super-admin/);
  });
});
