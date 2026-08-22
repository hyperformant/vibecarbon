import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armDeadAirGuard, disarmDeadAirGuard, spinner } from '../../../../src/lib/cli/progress.js';

/**
 * Dead-air guard: if nothing renders for >2s during a deploy — no
 * stdout/stderr writes, no registered spinner, no prompt waiting on raw-mode
 * stdin — a self-drawn fallback line appears and [deadair] markers are
 * emitted. Silent awaits (the class behind the pre-plan hang fixed in
 * a3bb44e) can no longer look like a hung deploy.
 *
 * Spec: the deadair-guard-design spec
 */

const THRESHOLD = 2_000;

function arm(overrides: Record<string, unknown> = {}) {
  const draws: string[] = [];
  const markers: number[] = [];
  armDeadAirGuard({
    isTTY: true,
    stdinIsRaw: () => false,
    drawWrite: (s: string) => {
      draws.push(s);
      return true;
    },
    onDeadAir: (secs: number) => {
      markers.push(secs);
    },
    ...overrides,
  });
  return { draws, markers };
}

const frames = (draws: string[]) => draws.filter((d) => d.includes('Still working'));
const erases = (draws: string[]) =>
  draws.filter((d) => d.includes('\u001b[2K') && !d.includes('Still working'));

describe('armDeadAirGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    disarmDeadAirGuard();
    vi.useRealTimers();
  });

  it('draws a fallback frame after the threshold, not before', () => {
    const { draws } = arm();
    vi.advanceTimersByTime(THRESHOLD - 500);
    expect(frames(draws)).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(frames(draws).length).toBeGreaterThan(0);
  });

  it('a foreign stdout write erases the fallback and resets the window', () => {
    const { draws } = arm();
    vi.advanceTimersByTime(3_000);
    expect(frames(draws).length).toBeGreaterThan(0);
    process.stdout.write('◇ Bundle packed\n');
    expect(erases(draws).length).toBeGreaterThan(0);
    const framesBefore = frames(draws).length;
    vi.advanceTimersByTime(1_000); // window restarted — still under threshold
    expect(frames(draws)).toHaveLength(framesBefore);
  });

  it('an active registered spinner suppresses fallback and markers', () => {
    const { draws, markers } = arm();
    const s = spinner();
    s.start('Real step running');
    const framesAfterStart = frames(draws).length;
    vi.advanceTimersByTime(10_000);
    expect(frames(draws)).toHaveLength(framesAfterStart);
    expect(markers).toHaveLength(0);
    s.stop('Real step done');
  });

  it('raw-mode stdin (a clack prompt waiting for input) suppresses fallback and markers', () => {
    const { draws, markers } = arm({ stdinIsRaw: () => true });
    vi.advanceTimersByTime(10_000);
    expect(frames(draws)).toHaveLength(0);
    expect(markers).toHaveLength(0);
  });

  it('emits a marker on entering dead air and every ~5s while it persists', () => {
    const { markers } = arm();
    vi.advanceTimersByTime(2_500);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toBeGreaterThanOrEqual(2);
    vi.advanceTimersByTime(5_000);
    expect(markers).toHaveLength(2);
    expect(markers[1]).toBeGreaterThanOrEqual(7);
  });

  it('does not draw frames when not a TTY, but still emits markers', () => {
    const { draws, markers } = arm({ isTTY: false });
    vi.advanceTimersByTime(3_000);
    expect(frames(draws)).toHaveLength(0);
    expect(markers.length).toBeGreaterThan(0);
  });

  it('disarm restores the original write references and erases a visible fallback', () => {
    const stdoutBefore = process.stdout.write;
    const stderrBefore = process.stderr.write;
    const { draws } = arm();
    expect(process.stdout.write).not.toBe(stdoutBefore);
    vi.advanceTimersByTime(3_000);
    disarmDeadAirGuard();
    expect(process.stdout.write).toBe(stdoutBefore);
    expect(process.stderr.write).toBe(stderrBefore);
    expect(erases(draws).length).toBeGreaterThan(0);
    const framesAfter = frames(draws).length;
    vi.advanceTimersByTime(10_000);
    expect(frames(draws)).toHaveLength(framesAfter); // interval gone
  });

  it('re-arming is idempotent (no stacked wraps)', () => {
    const stdoutBefore = process.stdout.write;
    arm();
    arm();
    disarmDeadAirGuard();
    expect(process.stdout.write).toBe(stdoutBefore);
  });
});

describe('withDeployLog wires the guard (source-level)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../../src/lib/deploy-logger.js', import.meta.url)),
    'utf8',
  );

  it('arms after installing the tee and disarms first in restore', () => {
    const tee = src.indexOf('process.stdout.write = tee(');
    const armAt = src.indexOf('armDeadAirGuard(');
    const restoreBody = src.indexOf('const restore =');
    const disarmAt = src.indexOf('disarmDeadAirGuard(');
    expect(tee).toBeGreaterThan(-1);
    expect(armAt).toBeGreaterThan(tee);
    expect(disarmAt).toBeGreaterThan(restoreBody);
    // disarm must run before the write references are restored
    expect(disarmAt).toBeLessThan(src.indexOf('process.stdout.write = originalStdoutWrite'));
  });

  it('passes the pre-tee terminal write as drawWrite (frames stay out of the log file)', () => {
    expect(src).toMatch(/drawWrite:\s*originalStdoutWrite/);
  });

  it('marker sink writes to the log stream', () => {
    expect(src).toMatch(/onDeadAir:[\s\S]{0,200}?\[deadair\]/);
  });
});
