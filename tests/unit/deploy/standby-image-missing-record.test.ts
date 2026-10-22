/**
 * R14: under -allow-degraded a k8s-ha deploy whose image copy failed finishes
 * degraded with a named cause, `standby-image-missing`. The final save writes
 * it beside the replication markers and clears it once a deploy copies the
 * image; failover refuses on it and status shows it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { describe, expect, it, vi } from 'vitest';
import { DEGRADED_CAUSE, preserveSafetyFields } from '../../../src/lib/deploy/env-safety-fields.js';
import {
  assertFailoverPreconditions,
  FailoverRefusedError,
} from '../../../src/lib/deploy/failover-guard.js';
import {
  finalSaveSafetyOwns,
  haDegradedRecord,
  k8sHaDegradedVerdict,
} from '../../../src/lib/deploy/orchestrator.js';
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

describe('k8sHaDegradedVerdict (the k8s-ha deployResult from the plan ctx)', () => {
  it('a missing standby image makes the deploy degraded and records the cause', () => {
    const verdict = k8sHaDegradedVerdict({
      replicationStatus: 'streaming',
      standbyImageMissing: true,
    });
    expect(verdict).toEqual({
      replication: 'streaming',
      standbyImageMissing: true,
      degraded: true,
    });
    expect(haDegradedRecord(verdict).degradedCause).toBe(DEGRADED_CAUSE.STANDBY_IMAGE_MISSING);
  });

  it('streaming with the image is clean; not streaming is degraded without the cause', () => {
    expect(k8sHaDegradedVerdict({ replicationStatus: 'streaming' })).toEqual({
      replication: 'streaming',
      standbyImageMissing: false,
      degraded: false,
    });
    const notStreaming = k8sHaDegradedVerdict({
      replicationStatus: 'DEGRADED (warm standby: NOT streaming)',
    });
    expect(notStreaming).toMatchObject({ replication: 'degraded', degraded: true });
    expect(haDegradedRecord(notStreaming).degradedCause).toBeUndefined();
  });

  it('the orchestrator builds the k8s-ha deployResult from it', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url)),
      'utf-8',
    );
    const after = src.slice(src.indexOf('const k8sHaCtx = { options: deploymentConfig };'));
    const block = after.slice(after.indexOf('deployResult = {'));
    expect(block.slice(0, block.indexOf('};'))).toContain('...k8sHaDegradedVerdict(k8sHaCtx),');
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

  const failover = (over: Record<string, unknown>) => () =>
    assertFailoverPreconditions({
      envConfig: envConfig(),
      environment: 'e4',
      standbyState,
      tier: 'k8s-ha',
      ...over,
    });

  it('planned (the primary answers): refuses and names the deploy that copies it', () => {
    const primaryState = { ...standbyState, inRecovery: false, receiverStatus: null };
    expect(failover({ planned: true, primaryState })).toThrow(FailoverRefusedError);
    expect(failover({ planned: true, primaryState })).toThrow(
      /missing the app image.*run this to copy it, then fail over:\n {2}vibecarbon deploy e4$/,
    );
  });

  it('unplanned without -force-unproven: refuses, naming the flag, not a deploy that cannot work', () => {
    expect(failover({})).toThrow(FailoverRefusedError);
    let message = '';
    try {
      failover({})();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/missing the app image.*primary is unreachable.*-force-unproven/);
    expect(message).not.toMatch(/run vibecarbon deploy/);
  });

  it('unplanned with -force-unproven: promotes, warning that the app is down until a deploy', () => {
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    try {
      expect(failover({ forceUnproven: true })()).toEqual({ mode: 'promote', unproven: true });
      const lines = warn.mock.calls
        .map(([m]) => String(m))
        .join('\n')
        .split('\n');
      expect(lines).toContain('  vibecarbon deploy e4');
      expect(lines.join(' ')).toMatch(
        /the promoted standby has no app image; it serves nothing until .*builds it there/,
      );
    } finally {
      warn.mockRestore();
    }
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
