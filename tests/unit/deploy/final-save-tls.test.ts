/**
 * The deploy's final save records the TLS verdict as envConfig.tls
 * ({ state, checkedAt, reason?, ca }). Failover and scale read its `ca` to pick
 * the snapshot (no record, no restore), and status shows its state. A deploy
 * that produced no verdict (no domain, or a tier that does not report one yet)
 * keeps the record on disk. `tls` is a safety field the final save owns: every
 * other whole-env writer keeps it as it is on disk.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENV_SAFETY_FIELDS,
  preserveSafetyFields,
} from '../../../src/lib/deploy/env-safety-fields.js';
import { finalSaveSafetyOwns, finalSaveTls } from '../../../src/lib/deploy/orchestrator.js';

const ON_DISK = { state: 'trusted', checkedAt: '2026-10-01T00:00:00.000Z', ca: 'prod' };
const PENDING = {
  state: 'pending',
  checkedAt: '2026-10-21T00:00:00.000Z',
  reason: 'self-signed certificate',
  ca: 'staging',
};

describe('finalSaveTls', () => {
  it('a deploy that reported a verdict persists it', () => {
    expect(finalSaveTls({ tls: PENDING }, { tls: ON_DISK })).toEqual(PENDING);
  });

  it('a deploy without a verdict keeps the on-disk record', () => {
    expect(finalSaveTls({}, { tls: ON_DISK })).toEqual(ON_DISK);
    expect(finalSaveTls(undefined, { tls: ON_DISK })).toEqual(ON_DISK);
  });

  it('neither gives no record', () => {
    expect(finalSaveTls({}, {})).toBeUndefined();
  });
});

describe('tls ownership', () => {
  it('is a safety field the final save owns on every tier', () => {
    expect(ENV_SAFETY_FIELDS).toContain('tls');
    expect(finalSaveSafetyOwns(true)).toContain('tls');
    expect(finalSaveSafetyOwns(false)).toContain('tls');
  });

  it('the final save writes its verdict over the disk record', () => {
    const disk = { status: 'deployed', tls: ON_DISK };
    const next = { ...disk, tls: finalSaveTls({ tls: PENDING }, disk) };
    expect(preserveSafetyFields(disk, next, { owns: finalSaveSafetyOwns(false) }).tls).toEqual(
      PENDING,
    );
  });

  it('a writer that does not own it (scale, the compose-ha mid-deploy saves) keeps the disk record', () => {
    const disk = { status: 'deployed', tls: PENDING };
    const stale = { status: 'deployed', tls: ON_DISK };
    expect(preserveSafetyFields(disk, stale).tls).toEqual(PENDING);
    expect(preserveSafetyFields(disk, { status: 'deployed' }).tls).toEqual(PENDING);
  });
});

describe('the orchestrator wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../src/lib/deploy/orchestrator.js', import.meta.url)),
    'utf-8',
  );

  it('the compose and compose-ha deployResults carry the effect verdict', () => {
    expect(src).toContain('...(composeCtx.tlsState && { tls: composeCtx.tlsState })');
    expect(src).toContain('...(composeHaCtx.tlsState && { tls: composeHaCtx.tlsState })');
  });

  it('the final save writes the record through finalSaveTls', () => {
    expect(src).toMatch(/finalSaveTls\(deployResult, persistedEnvConfig\)/);
  });
});
