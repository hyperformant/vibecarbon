import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { STATE_VERSION, StateTracker } from '../../../src/lib/deploy/state.js';

// Finding 2: shouldSkip must not skip a step whose remote resource was deleted
// out-of-band, and an incompatible persisted state (post-upgrade) must not be
// resumed. StateTracker keys its file off process.cwd()/.vibecarbon, so each
// test runs in an isolated temp cwd.

describe('StateTracker', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-state-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const stateFile = () => join(dir, '.vibecarbon', 'deploy-state-prod.json');

  describe('version invalidation', () => {
    it('stamps the current schema version on save', () => {
      const t = new StateTracker('proj', 'prod');
      t.startStep('s3-setup', { bucket: 'b' });
      const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
      expect(persisted.version).toBe(STATE_VERSION);
    });

    it('resumes a step when the persisted version matches', () => {
      const t1 = new StateTracker('proj', 'prod');
      t1.startStep('s3-setup', { bucket: 'b' });
      t1.completeStep('s3-setup', { ok: true });

      const t2 = new StateTracker('proj', 'prod');
      expect(t2.shouldSkip('s3-setup', { bucket: 'b' })).toBe(true);
    });

    it('auto-invalidates a persisted file with a mismatched version', () => {
      const t1 = new StateTracker('proj', 'prod');
      t1.startStep('s3-setup', { bucket: 'b' });
      t1.completeStep('s3-setup', { ok: true });

      // Simulate a pre-upgrade file: stamp an older version on disk.
      const stale = JSON.parse(readFileSync(stateFile(), 'utf-8'));
      stale.version = STATE_VERSION - 1;
      writeFileSync(stateFile(), JSON.stringify(stale));

      const t2 = new StateTracker('proj', 'prod');
      // Every step is treated as not-completed → no skip.
      expect(t2.shouldSkip('s3-setup', { bucket: 'b' })).toBe(false);
    });

    it('auto-invalidates a pre-versioning file (no version field)', () => {
      // Create the .vibecarbon dir via a throwaway tracker, then overwrite the
      // state file with a legacy (unversioned) shape that marks s3-setup done.
      const seed = new StateTracker('proj', 'prod');
      seed.startStep('s3-setup', { bucket: 'b' });
      seed.completeStep('s3-setup', { ok: true });
      const legacy = { steps: { 's3-setup': { status: 'completed', hash: 'stale' } } };
      writeFileSync(stateFile(), JSON.stringify(legacy));

      const t = new StateTracker('proj', 'prod');
      expect(t.state.version).toBe(STATE_VERSION);
      // Legacy completion is discarded — the step re-runs against reality.
      expect(t.shouldSkip('s3-setup', {})).toBe(false);
    });
  });

  describe('shouldSkipWithVerify', () => {
    function completed() {
      const t = new StateTracker('proj', 'prod');
      t.startStep('s3-setup', { bucket: 'b' });
      t.completeStep('s3-setup', { ok: true });
      return t;
    }

    it('returns false immediately when the hash does not match (never probes)', async () => {
      const t = completed();
      const verify = vi.fn().mockResolvedValue(true);
      expect(await t.shouldSkipWithVerify('s3-setup', { bucket: 'CHANGED' }, verify)).toBe(false);
      expect(verify).not.toHaveBeenCalled();
    });

    it('skips (true) when hash matches and the remote still exists', async () => {
      const t = completed();
      const verify = vi.fn().mockResolvedValue(true);
      expect(await t.shouldSkipWithVerify('s3-setup', { bucket: 'b' }, verify)).toBe(true);
      expect(verify).toHaveBeenCalledOnce();
    });

    it('re-runs (false) when hash matches but the remote is gone', async () => {
      const t = completed();
      const verify = vi.fn().mockResolvedValue(false);
      expect(await t.shouldSkipWithVerify('s3-setup', { bucket: 'b' }, verify)).toBe(false);
      expect(verify).toHaveBeenCalledOnce();
    });

    it('honors the hash decision (skip) when the probe throws', async () => {
      const t = completed();
      const verify = vi.fn().mockRejectedValue(new Error('S3 blip'));
      expect(await t.shouldSkipWithVerify('s3-setup', { bucket: 'b' }, verify)).toBe(true);
    });

    it('behaves like shouldSkip when no verifyFn is supplied', async () => {
      const t = completed();
      expect(await t.shouldSkipWithVerify('s3-setup', { bucket: 'b' })).toBe(true);
      expect(await t.shouldSkipWithVerify('s3-setup', { bucket: 'nope' })).toBe(false);
    });
  });

  it('clear() keeps the schema version', () => {
    const t = new StateTracker('proj', 'prod');
    t.startStep('s3-setup', { bucket: 'b' });
    t.clear();
    expect(t.state.version).toBe(STATE_VERSION);
    expect(t.state.steps).toEqual({});
  });
});
