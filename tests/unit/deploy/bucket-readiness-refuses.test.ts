/**
 * A bucket the provider acked but never made readable must stop the deploy
 * BEFORE anything is provisioned. Hetzner e2e 2026-09-21 (compose leg): the
 * backup bucket's 120s visibility probe exhausted, createBucket discarded
 * the result, the orchestrator swallowed backup-bucket errors, a VPS was
 * built, and wal-g's audit failed the deploy five minutes later with
 * NoSuchBucket. The bucket never appeared at all.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertBucketReady } from '../../../src/lib/deploy/orchestrator.js';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

function providerWithProbe(ready: boolean) {
  const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as {
    bucketExists: () => Promise<boolean>;
    _send: () => Promise<unknown>;
    waitForBucketVisible: () => Promise<boolean>;
    createBucket: (b: string) => Promise<{ name: string; created: boolean; ready: boolean }>;
  };
  p.bucketExists = vi.fn(async () => false);
  p._send = vi.fn(async () => ({}));
  p.waitForBucketVisible = vi.fn(async () => ready);
  return p;
}

describe('createBucket surfaces the visibility probe as `ready`', () => {
  it('ready: true when the probe held', async () => {
    await expect(providerWithProbe(true).createBucket('b')).resolves.toEqual({
      name: 'b',
      created: true,
      ready: true,
    });
  });
  it('ready: false when the probe exhausted its budget', async () => {
    await expect(providerWithProbe(false).createBucket('b')).resolves.toEqual({
      name: 'b',
      created: true,
      ready: false,
    });
  });
  it('an existing bucket is ready (HEAD already answered)', async () => {
    const p = providerWithProbe(false);
    p.bucketExists = vi.fn(async () => true);
    await expect(p.createBucket('b')).resolves.toMatchObject({ created: false, ready: true });
  });
});

describe('assertBucketReady', () => {
  it('returns for a ready bucket', () => {
    expect(() => assertBucketReady({ name: 'b', ready: true }, 'Backup')).not.toThrow();
  });
  it('refuses an unready bucket, naming it and the role, and says nothing was provisioned', () => {
    let err: Error | undefined;
    try {
      assertBucketReady({ name: 'proj-backups', ready: false }, 'Backup');
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain('Backup bucket proj-backups');
    expect(err?.message).toContain('Nothing was provisioned');
    expect(err?.message).toContain('vibecarbon deploy');
  });
});

describe('census: every createBucket call site is gated', () => {
  it('each `await s3Provider.createBucket(` in the orchestrator is followed by assertBucketReady on its result', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../../src/lib/deploy/orchestrator.js'),
      'utf-8',
    );
    const calls = [...src.matchAll(/const (\w+) = await s3Provider\.createBucket\(/g)];
    expect(calls.length).toBe(3);
    for (const m of calls) {
      const after = src.slice(m.index, m.index + 400);
      expect(after, `${m[1]} is not gated`).toMatch(new RegExp(`assertBucketReady\\(${m[1]},`));
    }
  });
  it('no other production file calls createBucket without the gate', () => {
    const hits = execSync("git grep -l 'createBucket(' -- 'src/**/*.js'", { encoding: 'utf-8' })
      .trim()
      .split('\n');
    expect(hits.sort()).toEqual(['src/lib/deploy/orchestrator.js', 'src/lib/providers/s3-base.js']);
  });
});
