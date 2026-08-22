/**
 * BUG C — killed e2e runs strand object-storage buckets, and nothing reaped them.
 *
 * Live receipt (2026-08-10 all-provider orphan audit): 21 orphaned `testapp-*`
 * buckets (app storage + Pulumi state) had been accumulating on Hetzner nbg1
 * since Jul 30, plus 3 more on DigitalOcean nyc3. A run killed before its
 * final destroy never reaps its own buckets, `scripts/sweep-hetzner.js` only
 * covers Hetzner, and no standing job looked at the other three providers at
 * all.
 *
 * The reaper's danger is obvious, so the selection logic is pure and pinned
 * here rather than discovered in production:
 *   - the DO subscription ANCHOR (`vc-local-e2e`, sfo3) is structurally
 *     excluded, independent of any prefix or age reasoning;
 *   - deletion is opt-in (dry-run is the default);
 *   - an age gate keeps a live run's freshly-created buckets out of scope, and
 *     it takes EVERY available age signal, not the most convenient one.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketTimestampMs,
  DO_SUBSCRIPTION_ANCHOR,
  isProtectedBucket,
  KNOWN_PROVIDER_IDS,
  PROTECTED_BUCKET_NAMES,
  parseSweepArgs,
  SWEEP_PROVIDERS,
  selectStaleBuckets,
} from '../../../scripts/sweep-buckets.js';

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0); // 2026-08-11T12:00:00Z
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A bucket row as the reaper sees it (provider listing + region context). */
function bucket(name: string, ageMs: number | null) {
  return {
    name,
    region: 'nbg1',
    creationDate: ageMs === null ? null : new Date(NOW - ageMs),
  };
}

/** e2e names embed the creation epoch: `testapp-<mode>-<epochMs>-<rand>-<suffix>`. */
function named(mode: string, ageMs: number, suffix = 'storage') {
  return `testapp-${mode}-${NOW - ageMs}-a1b2c3-${suffix}`;
}

describe('the DigitalOcean subscription anchor is structurally protected', () => {
  it('names the anchor explicitly, and it is on the protected list', () => {
    // `vc-local-e2e` (sfo3) is a DELIBERATE Spaces subscription anchor: DO
    // bills Spaces per-subscription, and deleting the last bucket cancels it.
    // Losing it is catastrophic and NOT recoverable by re-creating a bucket.
    expect(DO_SUBSCRIPTION_ANCHOR).toBe('vc-local-e2e');
    expect(PROTECTED_BUCKET_NAMES).toContain(DO_SUBSCRIPTION_ANCHOR);
  });

  it('protects the anchor by NAME on every provider and in every region', () => {
    // Name-only, deliberately: the guard must not depend on correctly
    // identifying the provider or region of the row being considered.
    expect(isProtectedBucket('vc-local-e2e')).toBe(true);
    expect(isProtectedBucket('VC-Local-E2E')).toBe(true);
    expect(isProtectedBucket('testapp-compose-1-storage')).toBe(false);
  });

  it('never selects the anchor, even when it matches the prefix and is ancient', () => {
    // The prefix scoping already excludes it in practice. This asserts the
    // SECOND, independent guard — a future prefix change (or an operator
    // passing `--prefix=vc-`) must not be able to reach it.
    const { stale, kept } = selectStaleBuckets([bucket(DO_SUBSCRIPTION_ANCHOR, 400 * DAY)], {
      prefix: 'vc-',
      now: NOW,
      maxAgeMs: DAY,
    });

    expect(stale).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0].reason).toMatch(/protected/i);
  });
});

describe('age gate', () => {
  it('selects a bucket older than the threshold on both signals', () => {
    const name = named('compose', 3 * DAY);
    const { stale } = selectStaleBuckets([bucket(name, 3 * DAY)], {
      prefix: 'testapp-',
      now: NOW,
      maxAgeMs: DAY,
    });

    expect(stale.map((b) => b.name)).toEqual([name]);
  });

  it('keeps a bucket younger than the threshold — a live run owns it', () => {
    const name = named('compose', 2 * HOUR);
    const { stale, kept } = selectStaleBuckets([bucket(name, 2 * HOUR)], {
      prefix: 'testapp-',
      now: NOW,
      maxAgeMs: DAY,
    });

    expect(stale).toEqual([]);
    expect(kept[0].reason).toMatch(/younger than/i);
  });

  it('requires EVERY available signal to be old, not just the convenient one', () => {
    // A bucket whose NAME is ancient but which the provider created minutes
    // ago is a live run reusing a retried scenario's project name. Deleting it
    // mid-run is the failure mode an age gate exists to prevent, so the
    // disagreement resolves toward keeping.
    const name = named('compose', 30 * DAY);
    const { stale, kept } = selectStaleBuckets([bucket(name, 5 * HOUR)], {
      prefix: 'testapp-',
      now: NOW,
      maxAgeMs: DAY,
    });

    expect(stale).toEqual([]);
    expect(kept[0].reason).toMatch(/younger than/i);
  });

  it('falls back to the name timestamp when the provider reports no creation date', () => {
    const name = named('k8s', 9 * DAY);
    const { stale } = selectStaleBuckets([bucket(name, null)], {
      prefix: 'testapp-',
      now: NOW,
      maxAgeMs: DAY,
    });

    expect(stale.map((b) => b.name)).toEqual([name]);
  });

  it('keeps a bucket with NO age signal at all', () => {
    // No creation date and no parseable timestamp: unknown age is not "old".
    const { stale, kept } = selectStaleBuckets([bucket('testapp-handmade-storage', null)], {
      prefix: 'testapp-',
      now: NOW,
      maxAgeMs: DAY,
    });

    expect(stale).toEqual([]);
    expect(kept[0].reason).toMatch(/no age signal/i);
  });

  it('ignores buckets outside the scratch prefix entirely', () => {
    const { stale, kept } = selectStaleBuckets(
      [
        bucket('vibecarbon-web-prod-storage', 400 * DAY),
        bucket(named('compose', 5 * DAY), 5 * DAY),
      ],
      { prefix: 'testapp-', now: NOW, maxAgeMs: DAY },
    );

    expect(stale).toHaveLength(1);
    expect(kept.map((b) => b.name)).toEqual(['vibecarbon-web-prod-storage']);
    expect(kept[0].reason).toMatch(/prefix/i);
  });
});

describe('the timestamp embedded in e2e bucket names', () => {
  it('reads the epoch out of a storage bucket name', () => {
    expect(bucketTimestampMs('testapp-compose-1754870000000-a1b2c3-storage')).toBe(1754870000000);
  });

  it('reads it out of the derived state-bucket name too', () => {
    // deriveStateBucketName appends to the app bucket, so the timestamp is
    // still in there — both halves of a run's pair age together.
    expect(bucketTimestampMs('testapp-k8s-1754870000000-a1b2c3-storage-pulumi-state-9f8e7d')).toBe(
      1754870000000,
    );
  });

  it('returns null when there is no epoch-shaped run id', () => {
    expect(bucketTimestampMs('vc-local-e2e')).toBeNull();
    expect(bucketTimestampMs('testapp-storage')).toBeNull();
    // A short number is a version or a region digit, not a millisecond epoch.
    expect(bucketTimestampMs('testapp-compose-42-storage')).toBeNull();
  });
});

describe('command-line posture', () => {
  it('is dry-run by default — deleting takes an explicit flag', () => {
    expect(parseSweepArgs([]).dryRun).toBe(true);
    expect(parseSweepArgs(['--older-than=48']).dryRun).toBe(true);
    expect(parseSweepArgs(['--delete']).dryRun).toBe(false);
  });

  it('defaults the age gate to 24h and accepts an override', () => {
    expect(parseSweepArgs([]).maxAgeMs).toBe(DAY);
    expect(parseSweepArgs(['--older-than=48']).maxAgeMs).toBe(48 * HOUR);
    expect(parseSweepArgs(['--older-than=0.5']).maxAgeMs).toBe(HOUR / 2);
  });

  it('sweeps every provider unless scoped to one', () => {
    expect(parseSweepArgs([]).providers).toEqual([
      'hetzner',
      'digitalocean',
      'linode',
      'vultr',
      'scaleway',
    ]);
    expect(parseSweepArgs(['--provider=linode']).providers).toEqual(['linode']);
  });

  it('rejects a bad age instead of silently sweeping everything', () => {
    expect(() => parseSweepArgs(['--older-than=nonsense'])).toThrow(/--older-than/);
    expect(() => parseSweepArgs(['--older-than=-3'])).toThrow(/--older-than/);
  });

  it('rejects an unknown provider instead of silently sweeping none', () => {
    expect(() => parseSweepArgs(['--provider=aws'])).toThrow(/aws/);
  });

  it('covers every provider in the compute registry', () => {
    // A fifth provider added to PROVIDERS without a row here would leak its
    // buckets exactly the way the other three did before this reaper existed
    // — invisibly, because nothing was looking.
    expect([...SWEEP_PROVIDERS].sort()).toEqual([...KNOWN_PROVIDER_IDS].sort());
  });
});
