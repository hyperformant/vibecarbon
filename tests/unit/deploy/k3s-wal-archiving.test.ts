/**
 * Regression guard for the k8s WAL-archiving deploy failure (RCA 2026-05-30).
 *
 * `feat/k8s-walg-backups` enabled continuous WAL archiving by sending four
 * `ALTER SYSTEM` statements to supabase-db in a SINGLE `psql -c` string. psql
 * sends one `-c` string as a single simple-query request, which Postgres runs
 * inside one implicit transaction — and `ALTER SYSTEM cannot run inside a
 * transaction block`. The deploy threw on every k8s + k8s-ha run:
 *
 *   ERROR:  ALTER SYSTEM cannot run inside a transaction block
 *   Error: applyK3sManifests: enable WAL archiving (ALTER SYSTEM) failed with exit 1
 *
 * The fix (the PostgreSQL-documented remedy, matching compose/ha.js) is to pass
 * each ALTER SYSTEM as its own `-c` option so each is its own implicit
 * transaction. These tests pin that: no `-c` payload may bundle multiple
 * statements.
 */
import { describe, expect, it } from 'vitest';
import {
  enableWalArchivingPsqlArgs,
  WAL_ARCHIVING_SETTINGS,
} from '../../../src/lib/deploy/k8s/k3s.js';

/** Pull the value following each `-c` flag out of the psql arg list. */
function cPayloads(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') out.push(args[i + 1]);
  }
  return out;
}

describe('enableWalArchivingPsqlArgs', () => {
  const args = enableWalArchivingPsqlArgs('supabase-supabase-db-0');

  it('targets the named db pod via kubectl exec + psql as supabase_admin', () => {
    expect(args.slice(0, 5)).toEqual(['-n', 'vibecarbon', 'exec', 'supabase-supabase-db-0', '--']);
    expect(args).toContain('psql');
    expect(args).toContain('supabase_admin');
  });

  it('sends each ALTER SYSTEM as its OWN -c so none runs inside a transaction block', () => {
    const payloads = cPayloads(args);
    // One -c per setting — never a single semicolon-joined multi-statement -c.
    expect(payloads).toHaveLength(WAL_ARCHIVING_SETTINGS.length);
    for (const payload of payloads) {
      const alterCount = (payload.match(/ALTER SYSTEM/g) ?? []).length;
      expect(alterCount).toBe(1);
    }
  });

  it('covers exactly the four archive settings wal-g needs', () => {
    const joined = cPayloads(args).join('\n');
    expect(joined).toMatch(/archive_mode='on'/);
    expect(joined).toMatch(/archive_command=/);
    expect(joined).toMatch(/archive_timeout='900'/);
    expect(joined).toMatch(/wal_level='replica'/);
  });
});
