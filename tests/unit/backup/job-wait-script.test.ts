import { describe, expect, it } from 'vitest';
import { buildBackupJobWaitScript } from '../../../src/backup.js';

// The k8s manual-backup path creates a one-off Job from the CronJob template and
// polls its conditions for Complete=True / Failed=True. wal-g push is ~11s but
// the measured triggerJob wall-clock (~41s) is dominated by pod scheduling +
// image start; the poll's job is to DETECT completion promptly once it happens.
// A flat 5s poll adds up to 5s of tail latency after the condition fires — ramp
// the interval (2 → 3 → 5) so early detection is tight while a genuinely slow
// job still backs off. The first condition check MUST remain immediate.
describe('buildBackupJobWaitScript', () => {
  it('ramps the poll interval 2 → 3 → 5 instead of a flat 5s', () => {
    const script = buildBackupJobWaitScript('backup-manual-2026-07-11');
    expect(script).toContain('INTERVAL=2');
    expect(script).toContain('INTERVAL=3');
    expect(script).toContain('INTERVAL=5');
    // The loop sleeps the current ramped interval, not a hard-coded 5.
    expect(script).toMatch(/sleep "\$INTERVAL"/);
  });

  it('checks the Job conditions BEFORE the first sleep (immediate first probe)', () => {
    const script = buildBackupJobWaitScript('j');
    const whileIdx = script.indexOf('while [');
    expect(whileIdx).toBeGreaterThan(-1);
    const firstCondsIdx = script.indexOf('CONDS=', whileIdx);
    const firstSleepIdx = script.indexOf('sleep "$INTERVAL"', whileIdx);
    expect(firstCondsIdx).toBeGreaterThan(-1);
    expect(firstSleepIdx).toBeGreaterThan(-1);
    // Condition read precedes the first sleep inside the loop body.
    expect(firstCondsIdx).toBeLessThan(firstSleepIdx);
  });

  it('keeps the 300s deadline ceiling (a load-bearing budget, unchanged)', () => {
    expect(buildBackupJobWaitScript('j')).toContain('date +%s) + 300');
  });

  it('interpolates the job name into the poll + diagnostics', () => {
    const script = buildBackupJobWaitScript('backup-manual-zzz');
    expect(script).toContain('backup-manual-zzz');
  });
});
