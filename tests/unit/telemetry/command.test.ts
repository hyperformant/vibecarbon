import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTelemetryState } from '../../../src/lib/telemetry/state.js';
import { run } from '../../../src/telemetry.js';

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-tcmd-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => {
    logs.push(a.join(' '));
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('vibecarbon telemetry', () => {
  it('off persists disabled=true; on re-enables', async () => {
    await run(['off'], { stateDir: dir });
    expect(getTelemetryState(dir).disabled).toBe(true);
    await run(['on'], { stateDir: dir });
    expect(getTelemetryState(dir).disabled).toBe(false);
  });

  it('status reports the effective state and the reason', async () => {
    await run(['status'], { stateDir: dir, env: {} as NodeJS.ProcessEnv });
    expect(logs.join('\n')).toMatch(/enabled/i);
    logs = [];
    await run(['status'], { stateDir: dir, env: { DO_NOT_TRACK: '1' } });
    expect(logs.join('\n')).toMatch(/disabled/i);
    expect(logs.join('\n')).toMatch(/DO_NOT_TRACK/);
  });

  it('bare `telemetry` behaves like status', async () => {
    await run([], { stateDir: dir, env: {} as NodeJS.ProcessEnv });
    expect(logs.join('\n')).toMatch(/enabled/i);
  });
});
