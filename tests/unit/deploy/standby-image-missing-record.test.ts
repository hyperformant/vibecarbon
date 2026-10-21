/**
 * R14: under -allow-degraded a k8s-ha deploy whose image copy failed finishes
 * degraded with a named cause, `standby-image-missing`. The final save writes
 * it beside the replication markers and clears it once a deploy copies the
 * image; failover refuses on it and status shows it.
 */
import { describe, expect, it } from 'vitest';
import { DEGRADED_CAUSE, preserveSafetyFields } from '../../../src/lib/deploy/env-safety-fields.js';
import {
  assertFailoverPreconditions,
  FailoverRefusedError,
} from '../../../src/lib/deploy/failover-guard.js';
import { finalSaveSafetyOwns, haDegradedRecord } from '../../../src/lib/deploy/orchestrator.js';
import { standbyImageRow } from '../../../src/status.js';

const SYSID = '7412345678901234567';

describe('haDegradedRecord', () => {
  it('a streaming deploy whose copy failed is degraded with the named cause', () => {
    expect(
      haDegradedRecord({ replication: 'streaming', degraded: true, standbyImageMissing: true }),
    ).toEqual({
      replication: 'streaming',
      degraded: true,
      degradedCause: DEGRADED_CAUSE.STANDBY_IMAGE_MISSING,
    });
  });

  it('a clean deploy clears a cause an earlier deploy recorded', () => {
    const disk = {
      replication: 'streaming',
      degraded: true,
      degradedCause: 'standby-image-missing',
    };
    const next = {
      ...disk,
      ...haDegradedRecord({ replication: 'streaming', degraded: false }),
    };
    const saved = JSON.parse(
      JSON.stringify(preserveSafetyFields(disk, next, { owns: finalSaveSafetyOwns(true) })),
    );
    expect(saved).toEqual({ replication: 'streaming', degraded: false });
  });

  it('keeps the replication verdict when only replication is degraded (compose-ha shape)', () => {
    expect(haDegradedRecord({ degraded: true, replication: 'degraded' })).toEqual({
      replication: 'degraded',
      degraded: true,
      degradedCause: undefined,
    });
    expect(haDegradedRecord({ degraded: true })).toMatchObject({ replication: 'degraded' });
  });

  it('a whole-env writer that does not own the cause keeps it from disk', () => {
    const disk = { degraded: true, degradedCause: 'standby-image-missing' };
    expect(preserveSafetyFields(disk, { degraded: false }).degradedCause).toBe(
      'standby-image-missing',
    );
  });
});

describe('failover on a standby without the app image', () => {
  const envConfig = (over: Record<string, unknown> = {}) => ({
    replication: 'streaming',
    degraded: true,
    degradedCause: 'standby-image-missing',
    deployedAt: '2026-10-01T00:00:00.000Z',
    ha: { systemIdentifier: SYSID, ...((over.ha as Record<string, unknown>) ?? {}) },
  });
  const standbyState = {
    inRecovery: true,
    systemIdentifier: SYSID,
    replayLsn: '0/3000060',
    receiverStatus: 'streaming',
    lastMsgAgeS: 1,
  };

  it('refuses, naming the cause, even with -force-unproven -allow-degraded', () => {
    for (const flags of [{}, { forceUnproven: true, allowDegraded: true }]) {
      expect(() =>
        assertFailoverPreconditions({
          envConfig: envConfig(),
          environment: 'e4',
          standbyState,
          tier: 'k8s-ha',
          ...flags,
        }),
      ).toThrow(FailoverRefusedError);
    }
    expect(() =>
      assertFailoverPreconditions({
        envConfig: envConfig(),
        environment: 'e4',
        standbyState,
        tier: 'k8s-ha',
      }),
    ).toThrow(/missing the app image.*vibecarbon deploy e4/);
  });

  it('does not stop a failover already in flight from finishing (R6)', () => {
    expect(
      assertFailoverPreconditions({
        envConfig: envConfig({
          ha: { failoverInFlight: { id: 'j1', target: 'standby', systemIdentifier: SYSID } },
        }),
        environment: 'e4',
        standbyState: { ...standbyState, inRecovery: false },
        tier: 'k8s-ha',
      }),
    ).toEqual({ mode: 'resume' });
  });
});

describe('status', () => {
  it('shows the missing standby image and how to fix it', () => {
    expect(standbyImageRow({ degradedCause: 'standby-image-missing' }, 'e4')).toMatch(
      /app image missing.*failover refuses.*vibecarbon deploy e4/,
    );
    expect(standbyImageRow({ degraded: true }, 'e4')).toBeNull();
    expect(standbyImageRow({}, 'e4')).toBeNull();
  });
});
