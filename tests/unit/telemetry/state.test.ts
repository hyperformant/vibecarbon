import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getTelemetryState,
  isAnalyticsDisabled,
  markNoticeShown,
  setTelemetryDisabled,
} from '../../../src/lib/telemetry/state.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-telemetry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getTelemetryState', () => {
  it('creates a persistent random machineId on first call', () => {
    const first = getTelemetryState(dir);
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.disabled).toBe(false);
    expect(first.noticeShown).toBe(false);
    const second = getTelemetryState(dir);
    expect(second.machineId).toBe(first.machineId); // stable across calls
    const onDisk = JSON.parse(readFileSync(join(dir, 'telemetry.json'), 'utf-8'));
    expect(onDisk.machineId).toBe(first.machineId);
  });

  it('recovers from a corrupt state file by regenerating', () => {
    getTelemetryState(dir);
    writeFileSync(join(dir, 'telemetry.json'), '{corrupt');
    expect(() => getTelemetryState(dir)).not.toThrow();
    expect(getTelemetryState(dir).machineId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('setTelemetryDisabled / markNoticeShown', () => {
  it('persists the flags', () => {
    getTelemetryState(dir);
    setTelemetryDisabled(true, dir);
    expect(getTelemetryState(dir).disabled).toBe(true);
    markNoticeShown(dir);
    expect(getTelemetryState(dir).noticeShown).toBe(true);
    setTelemetryDisabled(false, dir);
    expect(getTelemetryState(dir).disabled).toBe(false);
  });
});

describe('isAnalyticsDisabled', () => {
  const cleanEnv = {} as NodeJS.ProcessEnv;

  it('is false by default', () => {
    expect(isAnalyticsDisabled(cleanEnv, dir)).toBe(false);
  });

  it.each([
    [{ VIBECARBON_TELEMETRY_DISABLED: '1' }],
    [{ DO_NOT_TRACK: '1' }],
    [{ DO_NOT_TRACK: 'true' }],
    [{ CI: 'true' }],
    [{ CI: '1' }],
  ])('is true with env %j', (env) => {
    expect(isAnalyticsDisabled(env as NodeJS.ProcessEnv, dir)).toBe(true);
  });

  it.each([[{ DO_NOT_TRACK: '0' }], [{ DO_NOT_TRACK: '' }], [{ CI: '' }]])(
    'stays false with env %j',
    (env) => {
      expect(isAnalyticsDisabled(env as NodeJS.ProcessEnv, dir)).toBe(false);
    },
  );

  it('is true when persistently disabled', () => {
    setTelemetryDisabled(true, dir);
    expect(isAnalyticsDisabled(cleanEnv, dir)).toBe(true);
  });
});
