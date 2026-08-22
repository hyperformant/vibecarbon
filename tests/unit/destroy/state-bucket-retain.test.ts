import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { retainStateBucket } from '../../../src/destroy.js';

/**
 * Destroy KEEPS the dedicated Pulumi state bucket. This replaces the deletion
 * contract that used to live here (state-bucket-delete.test.ts).
 *
 * Why the inversion: deleting the bucket and letting the next deploy recreate
 * one of the same name is how acked writes were lost on 2026-08-07 (e4
 * restore->failover — the standby's `up` succeeded and served traffic, and its
 * state was absent from the recreated bucket 45+ minutes later). The mitigation
 * was to rotate the bucket NAME on every verified destroy, which guaranteed
 * every redeploy landed on a brand-new bucket — the worst window for this whole
 * class. Keeping the bucket removes the hazard AND the rotation.
 *
 * The assertions that matter are the negative ones: nothing is deleted, no
 * credentials are resolved, and — critically — nothing reaches the leak ledger,
 * because `leak` and `unverified` both count toward `survivors` and would make
 * every clean destroy report a leftover.
 */

const spinnerStub = () => {
  const messages: string[] = [];
  return {
    messages,
    start: (m?: string) => messages.push(`start:${m ?? ''}`),
    stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
  };
};

describe('retainStateBucket', () => {
  const envConfig = {
    s3: { bucket: 'proj-storage', stateBucket: 'proj-storage-pulumi-state-a1b2c3' },
  };
  const projectConfig = { projectName: 'proj' };

  it('keeps the dedicated state bucket and says so', async () => {
    const spinner = spinnerStub();
    await retainStateBucket(envConfig, projectConfig, {}, spinner, {
      leak: vi.fn(),
      unverified: vi.fn(),
    });
    expect(spinner.messages.join('\n')).toContain('proj-storage-pulumi-state-a1b2c3');
    expect(spinner.messages.join('\n')).toMatch(/kept/i);
  });

  it('no-ops for a pre-split env whose state lived in the app bucket', async () => {
    // That bucket is removed by the normal app-bucket path; there is no
    // separate bucket to keep, and claiming one was kept would be a lie.
    const spinner = spinnerStub();
    await retainStateBucket(
      { s3: { bucket: 'proj-storage', stateBucket: 'proj-storage' } },
      projectConfig,
      {},
      spinner,
      { leak: vi.fn(), unverified: vi.fn() },
    );
    expect(spinner.messages).toEqual([]);
  });

  it('no-ops when the env has no state bucket at all', async () => {
    const spinner = spinnerStub();
    await retainStateBucket({ s3: { bucket: 'proj-storage' } }, projectConfig, {}, spinner, {
      leak: vi.fn(),
      unverified: vi.fn(),
    });
    expect(spinner.messages).toEqual([]);
  });

  it('deletes ONLY behind -purge — the default path never touches credentials', async () => {
    // Without -purge the delete/credential machinery must be unreachable, or
    // the write-loss hazard returns. The purge branch (args.purgeBackups) is
    // the one sanctioned deletion path (review finding, 2026-08-15: there was
    // previously none at all), so the source-shape assertion pins that every
    // delete call sits inside that branch rather than banning it outright.
    const spinner = spinnerStub();
    await retainStateBucket(envConfig, projectConfig, { purgeBackups: false }, spinner, {
      leak: vi.fn(),
      unverified: vi.fn(),
    });
    expect(spinner.messages.join('\n')).toMatch(/kept/i);
    // The kept line ADVERTISES -purge but must not report a purge happened.
    expect(spinner.messages.join('\n')).not.toMatch(/purged|purging/i);
    const source = retainStateBucket.toString();
    const purgeIdx = source.indexOf('purgeBackups');
    const keptIdx = source.lastIndexOf('spinner.start');
    expect(purgeIdx).toBeGreaterThan(-1);
    expect(keptIdx).toBeGreaterThan(purgeIdx);
    const purgeBranch = source.slice(purgeIdx, keptIdx);
    expect(purgeBranch).toContain('emptyAndDeleteBucket');
    const defaultPath = source.slice(keptIdx);
    expect(defaultPath).not.toMatch(/emptyAndDeleteBucket|promptObjectStorageCredentials/);
  });

  it('records nothing in the leak ledger on the keep path', async () => {
    // A retained bucket is an intended outcome. All four ledger severities
    // mean something it is not (leak/unverified feed `survivors` and fail the
    // exit code, foreign asserts not-ours, risk predicts a leak), so the keep
    // path must never touch the ledger — only the purge path may, and only on
    // its own failures.
    const leaks = { leak: vi.fn(), unverified: vi.fn(), risk: vi.fn(), foreign: vi.fn() };
    const spinner = spinnerStub();
    await retainStateBucket(envConfig, projectConfig, {}, spinner, leaks);
    expect(leaks.leak).not.toHaveBeenCalled();
    expect(leaks.unverified).not.toHaveBeenCalled();
    expect(leaks.risk).not.toHaveBeenCalled();
    expect(leaks.foreign).not.toHaveBeenCalled();
  });
});
