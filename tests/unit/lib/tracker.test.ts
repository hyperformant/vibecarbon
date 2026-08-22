/**
 * Unit tests for lib/tracker.js — step timing + persistent per-command logs.
 * Every deploy-side command threads a tracker; a regression here silently
 * breaks the timing tables and the ~/.vibecarbon step logs operators use for
 * post-mortems, so the recording semantics get pinned.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  // Full log surface: in a non-TTY test env progress.js's spinner() takes the
  // quiet path, which calls log.info/success/error/warn (not clack's spinner).
  log: { step: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
  note: vi.fn(),
}));
vi.mock('@clack/prompts', () => clackMock);

import { createPrefixedTracker, createTracker } from '../../../src/lib/tracker.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The tracker's log stream opens + flushes asynchronously; finish() ends the
// stream without awaiting it (fine in a long-lived CLI process). Poll briefly
// so assertions read the flushed file, not a race.
async function readLogWhenFlushed(logPath: string, needle: string): Promise<string> {
  const { existsSync, readFileSync } = await import('node:fs');
  for (let i = 0; i < 40; i++) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf-8');
      if (content.includes(needle)) return content;
    }
    await sleep(25);
  }
  return existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
}

describe('createTracker', () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-tracker-'));
    process.chdir(dir);
    clackMock.note.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('records spinner start/stop pairs as steps and totals them in finish()', async () => {
    const tracker = createTracker('deploy', { environment: 'prod' });
    const s = tracker.spinner();
    s.start('step one');
    await sleep(5);
    s.stop('step one done');
    s.start('step two');
    s.stop('step two done');

    const { elapsed, formatted, logPath } = tracker.finish();
    expect(elapsed).toBeGreaterThan(0);
    expect(formatted).toMatch(/^\d+s$|^\d+m \d+s$/);
    expect(logPath).toContain(join('.vibecarbon', 'logs'));
    expect(logPath).toContain('deploy-prod-');
    // Settle the async log stream before afterEach removes the temp dir.
    await readLogWhenFlushed(logPath as string, 'Finished:');
  });

  it('writes header, step lines, and summary to the log file', async () => {
    const tracker = createTracker('backup', { environment: 'stage' });
    const s = tracker.spinner();
    s.start('reading backups');
    s.stop('backups read');
    s.start('second step');
    s.stop('second done');
    const { logPath } = tracker.finish();

    const log = await readLogWhenFlushed(logPath as string, 'Finished:');
    expect(log).toContain('=== vibecarbon backup ===');
    expect(log).toContain('environment: stage');
    expect(log).toContain('START  reading backups');
    expect(log).toContain('DONE   backups read');
    expect(log).toContain('=== Step Summary ===');
    expect(log).toContain('TOTAL');
  });

  it('records an unstopped step when the next start() arrives (crash-resilient timing)', async () => {
    const tracker = createTracker('scale');
    const s = tracker.spinner();
    s.start('never stopped');
    s.start('next step');
    s.stop('next done');
    tracker.finish();

    // Both steps land in the summary: the abandoned one under its start label.
    const log = await readLogWhenFlushed(tracker.logPath as string, 'Finished:');
    expect(log).toContain('never stopped');
    expect(log).toContain('next done');
  });

  it('prints the stats note only when more than one step was recorded', async () => {
    const single = createTracker('up');
    const s1 = single.spinner();
    s1.start('only step');
    s1.stop('only step');
    single.finish();
    expect(clackMock.note).not.toHaveBeenCalled();

    const multi = createTracker('up');
    const s2 = multi.spinner();
    s2.start('a');
    s2.stop('a');
    s2.start('b');
    s2.stop('b');
    multi.finish();
    expect(clackMock.note).toHaveBeenCalledTimes(1);
    expect(clackMock.note.mock.calls[0][1]).toBe('Stats');
    // Settle both async log streams before afterEach removes the temp dir.
    await readLogWhenFlushed(single.logPath as string, 'Finished:');
    await readLogWhenFlushed(multi.logPath as string, 'Finished:');
  });

  it('survives an unwritable log location (logPath null, no throw)', () => {
    // Point cwd at a location where .vibecarbon/logs cannot be created.
    process.chdir('/');
    const tracker = createTracker('status');
    const s = tracker.spinner();
    s.start('x');
    s.stop('x');
    const { logPath } = tracker.finish();
    // Root is not writable for this user — tracker degrades to no logging.
    expect(logPath).toBeNull();
    process.chdir(dir);
  });
});

describe('createPrefixedTracker', () => {
  it('prefixes spinner output with the label and forwards to the parent log', () => {
    const parentLines: string[] = [];
    const parent = { log: (msg: string) => parentLines.push(msg) };
    const tracker = createPrefixedTracker('fsn1', { parent });

    const s = tracker.spinner();
    s.start('provisioning');
    s.message('halfway');
    s.stop('provisioned');
    tracker.log('note line');

    expect(parentLines[0]).toBe('[fsn1] START  provisioning');
    expect(parentLines[1]).toBe('[fsn1] UPDATE halfway');
    expect(parentLines[2]).toMatch(/^\[fsn1\] DONE {3}provisioned \(\d+s\)$/);
    expect(parentLines[3]).toBe('[fsn1] note line');
    expect(clackMock.log.step).toHaveBeenCalled();
  });

  it('is safe without a parent (no throw, no forwarding)', () => {
    const tracker = createPrefixedTracker('nbg1');
    const s = tracker.spinner();
    expect(() => {
      s.start('a');
      s.stop();
      tracker.log('b');
    }).not.toThrow();
  });
});
