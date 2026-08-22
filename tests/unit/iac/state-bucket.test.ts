import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { resolveBackendUrl } from '../../../src/lib/iac/index.js';
// @ts-expect-error — JS module without types
import {
  deriveStateBucketName,
  resolveStateBucketName,
} from '../../../src/lib/providers/hetzner-s3.js';

// Finding 1: Pulumi state must live in a DEDICATED bucket, not the app storage
// bucket. These tests pin the naming derivation + that resolveBackendUrl
// targets the state bucket (with a safe fallback for un-migrated configs).

describe('deriveStateBucketName', () => {
  it('appends -pulumi-state to the app bucket name', () => {
    expect(deriveStateBucketName('myapp-storage')).toBe('myapp-storage-pulumi-state');
  });

  it('is deterministic (same input → same output, so HA stacks share it)', () => {
    expect(deriveStateBucketName('myapp-storage')).toBe(deriveStateBucketName('myapp-storage'));
  });

  it('sanitizes to Hetzner bucket rules (lowercase, collapse hyphens, <=63 chars)', () => {
    const long = 'a'.repeat(80);
    const out = deriveStateBucketName(long);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out).toBe(out.toLowerCase());
    expect(out).not.toMatch(/--/);
  });
});

describe('resolveBackendUrl', () => {
  const savedBackend = process.env.PULUMI_BACKEND_URL;
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.PULUMI_BACKEND_URL;
    else process.env.PULUMI_BACKEND_URL = savedBackend;
  });

  it('targets the dedicated state bucket when stateBucket is set', () => {
    delete process.env.PULUMI_BACKEND_URL;
    const url = resolveBackendUrl({
      bucket: 'myapp-storage',
      stateBucket: 'myapp-storage-pulumi-state',
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
    });
    expect(url).toContain('s3://myapp-storage-pulumi-state?');
    expect(url).toContain('endpoint=fsn1.your-objectstorage.com');
    expect(url).toContain('region=fsn1');
    expect(url).toContain('s3ForcePathStyle=true');
    // Must NOT resolve to the app storage bucket.
    expect(url).not.toContain('s3://myapp-storage?');
  });

  it('falls back to the app bucket when stateBucket is absent (un-migrated config)', () => {
    delete process.env.PULUMI_BACKEND_URL;
    const url = resolveBackendUrl({
      bucket: 'myapp-storage',
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
    });
    expect(url).toContain('s3://myapp-storage?');
  });

  it('honors an explicit PULUMI_BACKEND_URL override', () => {
    process.env.PULUMI_BACKEND_URL = 'file:///tmp/custom-state';
    expect(
      resolveBackendUrl({ bucket: 'x', stateBucket: 'x-pulumi-state', endpoint: 'https://e' }),
    ).toBe('file:///tmp/custom-state');
  });
});

describe('resolveStateBucketName — precedence', () => {
  const appBucket = 'myapp-storage';

  it('a persisted env bucket wins over everything', () => {
    // An environment that has deployed must keep the exact bucket it has been
    // using; neither a project pin nor derivation may move it out from under
    // live state.
    expect(
      resolveStateBucketName({
        envStateBucket: 'live-env-state',
        projectPin: 'pinned-state',
        appBucket,
        generation: 'a1b2c3',
      }),
    ).toBe('live-env-state');
  });

  it('a project pin wins over derivation', () => {
    expect(
      resolveStateBucketName({ projectPin: 'pinned-state', appBucket, generation: 'a1b2c3' }),
    ).toBe('pinned-state');
  });

  it('falls back to derivation when nothing is pinned', () => {
    expect(resolveStateBucketName({ appBucket, generation: 'a1b2c3' })).toBe(
      deriveStateBucketName(appBucket, 'a1b2c3'),
    );
  });

  it('gives every scenario the same bucket when they share one pin', () => {
    // What lets the e2e harness reuse one long-lived bucket across scenarios
    // instead of creating a brand-new one per run. Safe because Pulumi keys
    // state as .pulumi/stacks/<project>/<stack>.json and the stack names differ.
    const pinned = 'vc-e2e-pulumi-state';
    const forScenario = (app: string) =>
      resolveStateBucketName({ projectPin: pinned, appBucket: app, generation: 'a1b2c3' });
    expect(forScenario('citest-compose-1-storage')).toBe(pinned);
    expect(forScenario('citest-k8s-ha-2-storage')).toBe(pinned);
  });
});

describe('resolveStateBucketName — pin validation', () => {
  it('rejects an empty-string pin instead of letting it win the fallback chain', () => {
    // '' is not nullish, so it used to beat derivation and build the malformed
    // backend URL `s3://?endpoint=...` (review finding, 2026-08-15).
    expect(() => resolveStateBucketName({ projectPin: '', appBucket: 'myapp-storage' })).toThrow(
      /Invalid stateBucket pin/,
    );
  });

  it('rejects invalid bucket characters and over-length names loudly, naming the fix', () => {
    for (const pin of ['My_State Bucket', 'UPPER', `x${'a'.repeat(80)}`, '-lead', 'trail-']) {
      expect(() => resolveStateBucketName({ projectPin: pin, appBucket: 'a-b' })).toThrow(
        /stateBucket/,
      );
    }
  });

  it('does not silently rewrite a pin — the operator chose that exact name', () => {
    // sanitizeBucketName would "fix" it; deploying under a different name than
    // the operator wrote is worse than telling them.
    expect(resolveStateBucketName({ projectPin: 'valid-pin-name', appBucket: 'a-b' })).toBe(
      'valid-pin-name',
    );
  });
});

describe('resolveBackendUrl — state bucket region', () => {
  it('prefers stateBucketRegion over the app buckets region', () => {
    // A retained state bucket can live where an earlier run created it; the
    // backend URL must follow the STATE bucket, while the app/backup config
    // stays in the run's own region.
    const url = resolveBackendUrl({
      bucket: 'app',
      stateBucket: 'state',
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
      stateBucketRegion: 'nbg1',
    });
    expect(url).toContain('region=nbg1');
  });

  it('falls back to the shared region when no split exists', () => {
    const url = resolveBackendUrl({
      bucket: 'app',
      stateBucket: 'state',
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
    });
    expect(url).toContain('region=fsn1');
  });
});
