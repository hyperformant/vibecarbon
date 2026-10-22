/**
 * Whole-env writers keep the on-disk safety records (Task 9 fix round 1).
 *
 * A deploy or scale that rebuilds its env entry from the copy it loaded
 * earlier must not roll back a record another step wrote to disk since: a
 * stranded write fence, a failover journal, a scale's cutover journal, a
 * standby's proof or its loss, a pending state sync, an unrestored lineage.
 */
import { describe, expect, it } from 'vitest';
import {
  ENV_SAFETY_FIELDS,
  preserveSafetyFields,
} from '../../../src/lib/deploy/env-safety-fields.js';
import { finalSaveSafetyOwns } from '../../../src/lib/deploy/orchestrator.js';

/** An env on disk carrying every safety record. */
const freshEnv = () => ({
  status: 'deploying',
  replication: 'degraded',
  degraded: true,
  pendingServerState: [{ stack: 'myapp-prod', serverId: 2 }],
  backup: { lineage: '7412', unrestoredPrior: '6999' },
  ha: {
    enabled: true,
    systemIdentifier: '7412',
    backupFence: { written: true },
    failoverInFlight: { id: 'j1' },
    writeFence: { ip: '1.1.1.1', cutover: { newIp: '2.2.2.2', done: [] } },
  },
});

/** What a writer built from a stale copy: none of the records, or old ones. */
const staleNext = () => ({
  status: 'deployed',
  replication: 'streaming',
  degraded: false,
  backup: { lineage: '7412' },
  ha: { enabled: true, failoverRegion: 'nbg1' },
});

describe('preserveSafetyFields', () => {
  it('takes every safety field the writer does not own from the env on disk', () => {
    const out = preserveSafetyFields(freshEnv(), staleNext());
    expect(out).toEqual({
      ...staleNext(),
      replication: 'degraded',
      degraded: true,
      pendingServerState: [{ stack: 'myapp-prod', serverId: 2 }],
      backup: { lineage: '7412', unrestoredPrior: '6999' },
      ha: { ...freshEnv().ha, failoverRegion: 'nbg1' },
    });
  });

  it('a field cleared on disk stays cleared, even when the stale copy still had it', () => {
    const next = { ...freshEnv(), status: 'deployed' };
    const out = preserveSafetyFields({ status: 'deploying', ha: { enabled: true } }, next);
    expect(out).toEqual({ status: 'deployed', backup: { lineage: '7412' }, ha: { enabled: true } });
  });

  it('a field the writer owns keeps the value it decided, set or cleared', () => {
    const next = { ...staleNext(), ha: { enabled: true, systemIdentifier: '9000' } };
    const out = preserveSafetyFields(freshEnv(), next, {
      owns: ['replication', 'degraded', 'ha.systemIdentifier', 'backup.unrestoredPrior'],
    });
    expect(out.replication).toBe('streaming');
    expect(out.degraded).toBe(false);
    expect(out.ha.systemIdentifier).toBe('9000');
    expect(out.backup).toEqual({ lineage: '7412' });
    // Not owned: still from disk.
    expect(out.ha.writeFence).toEqual(freshEnv().ha.writeFence);
    const cleared = preserveSafetyFields(
      freshEnv(),
      { ha: { enabled: true } },
      {
        owns: ['ha.systemIdentifier'],
      },
    );
    expect(cleared.ha).not.toHaveProperty('systemIdentifier');
  });

  it('leaves no empty ha behind when the only record in it was cleared on disk', () => {
    const out = preserveSafetyFields({}, { region: 'fsn1', ha: { writeFence: { ip: 'x' } } });
    expect(out).toEqual({ region: 'fsn1' });
  });

  it('refuses an owns entry that is not a safety field', () => {
    expect(() => preserveSafetyFields({}, {}, { owns: ['ha.primary'] })).toThrow(/not a safety/);
  });

  it('changes neither input', () => {
    const fresh = freshEnv();
    const next = staleNext();
    preserveSafetyFields(fresh, next);
    expect(fresh).toEqual(freshEnv());
    expect(next).toEqual(staleNext());
  });
});

describe("the deploy's final write", () => {
  it('owns replication, its degraded cause and the standby proof only on an HA deploy, and the lineage and TLS record always', () => {
    expect(finalSaveSafetyOwns(true).sort()).toEqual(
      [
        'backup.unrestoredPrior',
        'degraded',
        'degradedCause',
        'ha.systemIdentifier',
        'replication',
        'tls',
      ].sort(),
    );
    expect(finalSaveSafetyOwns(false)).toEqual(['backup.unrestoredPrior', 'tls']);
    for (const f of [...finalSaveSafetyOwns(true), ...finalSaveSafetyOwns(false)]) {
      expect(ENV_SAFETY_FIELDS).toContain(f);
    }
  });

  it('keeps a stranded fence, a journal and a pending sync, and clears an unverified proof', () => {
    const out = preserveSafetyFields(
      freshEnv(),
      { ...staleNext(), ha: { enabled: true, failoverRegion: 'nbg1' } },
      { owns: finalSaveSafetyOwns(true) },
    );
    expect(out.ha.writeFence).toEqual(freshEnv().ha.writeFence);
    expect(out.ha.failoverInFlight).toEqual({ id: 'j1' });
    expect(out.ha.backupFence).toEqual({ written: true });
    expect(out.pendingServerState).toEqual(freshEnv().pendingServerState);
    // This deploy did not verify streaming: no identifier on record.
    expect(out.ha).not.toHaveProperty('systemIdentifier');
    expect(out.replication).toBe('streaming');
  });
});
