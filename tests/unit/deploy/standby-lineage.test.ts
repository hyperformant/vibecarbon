/**
 * The cold reseed's lineage verdict, and the record `failover -abort` keeps
 * for a standby copy it gave up (final review I1).
 *
 * An aborted failover may already have promoted the standby: the same
 * database on a newer timeline. The next deploy's lineage check refused that
 * as a promotion made outside vibecarbon, so abort-then-deploy was blocked.
 * The abort now records the standby's exact lineage as discardable, and the
 * verdict lets through only that copy: same address, system identifier and
 * timeline. Any other promotion still refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  clearDiscardableStandby,
  DB_LINEAGE_SQL,
  discardableStandbyRecord,
  matchesDiscardableStandby,
  parseDbLineage,
  readDiscardableStandby,
  standbyLineageVerdict,
} from '../../../src/lib/deploy/standby-lineage.js';

const SYSID = '7412345678901234567';
const SOURCE = { systemIdentifier: SYSID, timeline: 2 };
const PROMOTED = { inRecovery: false, systemIdentifier: SYSID, timeline: 3 };
const RECORD = { ip: '2.2.2.2', systemIdentifier: SYSID, timeline: 3, at: 't' };

describe('parseDbLineage', () => {
  it('reads recovery, identifier and timeline; an in-recovery row has no timeline', () => {
    expect(parseDbLineage(`f|${SYSID}|00000003`)).toEqual(PROMOTED);
    expect(parseDbLineage(`notice\nt|${SYSID}|`)).toEqual({
      inRecovery: true,
      systemIdentifier: SYSID,
      timeline: null,
    });
    expect(parseDbLineage('')).toEqual({
      inRecovery: null,
      systemIdentifier: null,
      timeline: null,
    });
  });
  it('the SQL carries no quote, so it sits in a single-quoted shell word', () => {
    expect(DB_LINEAGE_SQL).not.toMatch(/['"]/);
    expect(DB_LINEAGE_SQL).toContain('pg_is_in_recovery()');
    expect(DB_LINEAGE_SQL).toContain('pg_walfile_name(pg_current_wal_lsn())');
  });
});

describe('discardableStandbyRecord', () => {
  it('records a standby read out of recovery with a whole lineage', () => {
    expect(discardableStandbyRecord({ ip: '2.2.2.2', reading: PROMOTED, at: 't' })).toEqual(RECORD);
  });
  it('records nothing for a standby in recovery, an unread one, or a partial read', () => {
    expect(
      discardableStandbyRecord({ ip: '2.2.2.2', reading: { ...PROMOTED, inRecovery: true } }),
    ).toBeNull();
    expect(discardableStandbyRecord({ ip: '2.2.2.2', reading: null })).toBeNull();
    expect(
      discardableStandbyRecord({ ip: '2.2.2.2', reading: { ...PROMOTED, timeline: null } }),
    ).toBeNull();
  });
});

describe('standbyLineageVerdict', () => {
  const v = (target: object, discardable: object | null = null) =>
    standbyLineageVerdict({ target, source: SOURCE, standbyIp: '2.2.2.2', discardable });

  it('in recovery, a fresh initdb and a retired old primary pass as before', () => {
    expect(v({ inRecovery: 't' })).toBe('standby');
    expect(v({ inRecovery: true })).toBe('standby');
    expect(v({ inRecovery: false, systemIdentifier: '1', timeline: 1 })).toBe('fresh');
    expect(v({ ...PROMOTED, timeline: 1 })).toBe('retired');
    expect(v({ ...PROMOTED, timeline: 2 })).toBe('retired');
  });

  it('an unrecorded promotion still refuses', () => {
    expect(v(PROMOTED)).toBe('promoted');
  });

  it('the copy the abort recorded passes as discardable', () => {
    expect(v(PROMOTED, RECORD)).toBe('discardable');
  });

  it('a record for another lineage, timeline or address unlocks nothing', () => {
    expect(v(PROMOTED, { ...RECORD, systemIdentifier: '7000000000000000001' })).toBe('promoted');
    expect(v(PROMOTED, { ...RECORD, timeline: 4 })).toBe('promoted');
    expect(v({ ...PROMOTED, timeline: 4 }, RECORD)).toBe('promoted');
    expect(v(PROMOTED, { ...RECORD, ip: '9.9.9.9' })).toBe('promoted');
    expect(v(PROMOTED, { ip: '2.2.2.2' })).toBe('promoted');
  });

  it('never reseeds blind: an unread side refuses, record or not', () => {
    expect(v({ inRecovery: false }, RECORD)).toBe('target-unread');
    expect(
      standbyLineageVerdict({
        target: PROMOTED,
        source: { systemIdentifier: null, timeline: null },
        standbyIp: '2.2.2.2',
        discardable: RECORD,
      }),
    ).toBe('source-unread');
  });

  it('matchesDiscardableStandby is exact', () => {
    expect(matchesDiscardableStandby(RECORD, { ip: '2.2.2.2', ...PROMOTED })).toBe(true);
    expect(matchesDiscardableStandby(null, { ip: '2.2.2.2', ...PROMOTED })).toBe(false);
  });
});

describe('the record on disk', () => {
  it('reads the env record, and a broken config reads as none', () => {
    const load = () => ({ environments: { prod: { ha: { discardableStandby: RECORD } } } });
    expect(readDiscardableStandby('prod', load)).toEqual(RECORD);
    expect(readDiscardableStandby('staging', load)).toBeNull();
    expect(
      readDiscardableStandby('prod', () => {
        throw new Error('bad json');
      }),
    ).toBeNull();
  });

  it('clearing drops only the record', () => {
    const config = {
      environments: { prod: { ha: { discardableStandby: RECORD, backupFence: { ok: true } } } },
    };
    clearDiscardableStandby('prod', (m: (c: typeof config) => unknown) => m(config));
    expect(config.environments.prod.ha).toEqual({ backupFence: { ok: true } });
  });
});

describe('standbyDbRebuildHint (final review I2)', () => {
  it('names the standby cluster, each kubectl step in order, the deploy and the doc', async () => {
    const { standbyDbRebuildHint } = await import('../../../src/lib/deploy/db-workload.js');
    const hint = standbyDbRebuildHint('prod');
    const steps = [
      'on the STANDBY cluster (never the primary)',
      '`kubectl scale statefulset/db --replicas=0 -n vibecarbon`',
      '`kubectl wait --for=delete pod/db-0 --timeout=600s -n vibecarbon`',
      '`kubectl delete pvc data-db-0 -n vibecarbon`',
      '`kubectl scale statefulset/db --replicas=1 -n vibecarbon`',
      '`vibecarbon deploy prod` seeds it from the primary',
      'docs/technical.md, "Rebuilding a k8s-ha standby whose db cannot start"',
    ];
    let at = -1;
    for (const step of steps) {
      const next = hint.indexOf(step);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    expect(hint).not.toMatch(/—/);
  });
});
