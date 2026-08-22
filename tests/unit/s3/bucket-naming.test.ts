import { describe, expect, it } from 'vitest';
import { sanitizeBucketName } from '../../../src/lib/providers/hetzner-s3.js';
import { deriveProjectBucketName } from '../../../src/lib/providers/s3-base.js';
import { generateBucketSalt } from '../../../src/lib/secrets.js';

describe('deriveProjectBucketName (per-project salt)', () => {
  // Two customers deploying identically-named projects share a provider's
  // global bucket namespace; the salt (generated once at `create`, persisted
  // top-level in .vibecarbon.json) makes their derived names disjoint.
  it('embeds bucketSalt between project name and suffix', () => {
    expect(deriveProjectBucketName({ projectName: 'myapp', bucketSalt: 'ab12cd' })).toBe(
      'myapp-ab12cd-storage',
    );
  });

  it('supports the backups suffix', () => {
    expect(deriveProjectBucketName({ projectName: 'myapp', bucketSalt: 'ab12cd' }, 'backups')).toBe(
      'myapp-ab12cd-backups',
    );
  });

  it('falls back to legacy unsalted names when the project has no salt', () => {
    // Pre-salt projects must keep deriving the exact names their deployed
    // environments already use — destroy finds buckets by these literals.
    expect(deriveProjectBucketName({ projectName: 'myapp' })).toBe('myapp-storage');
  });

  it('sanitizes name and salt through the same rules as sanitizeBucketName', () => {
    expect(deriveProjectBucketName({ projectName: 'My App', bucketSalt: 'AB12CD' })).toBe(
      'my-app-ab12cd-storage',
    );
  });

  it('keeps the project name as the leading prefix (e2e sweeps filter on it)', () => {
    const name = deriveProjectBucketName({ projectName: 'testapp-rig', bucketSalt: 'ab12cd' });
    expect(name.startsWith('testapp-rig-')).toBe(true);
  });
});

describe('generateBucketSalt', () => {
  it('produces 6 lowercase hex chars (valid in bucket names untransformed)', () => {
    expect(generateBucketSalt()).toMatch(/^[0-9a-f]{6}$/);
  });

  it('varies across calls', () => {
    const salts = new Set(Array.from({ length: 20 }, () => generateBucketSalt()));
    expect(salts.size).toBeGreaterThan(1);
  });
});

describe('sanitizeBucketName', () => {
  describe('basic transformations', () => {
    it('converts to lowercase', () => {
      expect(sanitizeBucketName('MyApp')).toBe('myapp-storage');
    });

    it('adds storage suffix by default', () => {
      expect(sanitizeBucketName('myapp')).toBe('myapp-storage');
    });

    it('allows custom suffix', () => {
      expect(sanitizeBucketName('myapp', 'backup')).toBe('myapp-backup');
    });

    it('allows no suffix', () => {
      expect(sanitizeBucketName('myapp', '')).toBe('myapp');
    });
  });

  describe('invalid character handling', () => {
    it('replaces underscores with hyphens', () => {
      expect(sanitizeBucketName('my_app')).toBe('my-app-storage');
    });

    it('replaces dots with hyphens', () => {
      expect(sanitizeBucketName('my.app')).toBe('my-app-storage');
    });

    it('replaces spaces with hyphens', () => {
      expect(sanitizeBucketName('my app')).toBe('my-app-storage');
    });

    it('replaces special characters with hyphens', () => {
      expect(sanitizeBucketName('my@app!name')).toBe('my-app-name-storage');
    });

    it('handles mixed invalid characters', () => {
      expect(sanitizeBucketName('My_App.Name 2026')).toBe('my-app-name-2026-storage');
    });
  });

  describe('hyphen normalization', () => {
    it('collapses multiple consecutive hyphens', () => {
      expect(sanitizeBucketName('my--app')).toBe('my-app-storage');
    });

    it('removes leading hyphens', () => {
      expect(sanitizeBucketName('-myapp')).toBe('myapp-storage');
    });

    it('removes trailing hyphens', () => {
      expect(sanitizeBucketName('myapp-')).toBe('myapp-storage');
    });

    it('handles multiple leading/trailing hyphens', () => {
      expect(sanitizeBucketName('---myapp---')).toBe('myapp-storage');
    });
  });

  describe('length constraints', () => {
    it('truncates to 63 characters', () => {
      const longName = 'a'.repeat(100);
      const result = sanitizeBucketName(longName, '');
      expect(result).toHaveLength(63);
    });

    it('truncates after adding suffix', () => {
      const longName = 'a'.repeat(70);
      const result = sanitizeBucketName(longName);
      // Truncates to 63 chars total (name + suffix may be cut)
      expect(result).toHaveLength(63);
      // The suffix may be partially truncated for very long names
      expect(result.startsWith('a')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(sanitizeBucketName('')).toBe('storage');
    });

    it('handles string with only invalid characters', () => {
      expect(sanitizeBucketName('!@#$%')).toBe('storage');
    });

    it('handles numbers', () => {
      expect(sanitizeBucketName('app123')).toBe('app123-storage');
    });

    it('handles all uppercase', () => {
      expect(sanitizeBucketName('MYAPP')).toBe('myapp-storage');
    });

    it('handles path-like input', () => {
      expect(sanitizeBucketName('../my-app')).toBe('my-app-storage');
    });
  });

  describe('real-world project names', () => {
    it('handles typical project name', () => {
      expect(sanitizeBucketName('vibecarbon-demo')).toBe('vibecarbon-demo-storage');
    });

    it('handles project name with version', () => {
      expect(sanitizeBucketName('my-app-v2')).toBe('my-app-v2-storage');
    });

    it('handles scoped package name', () => {
      expect(sanitizeBucketName('@org/my-package')).toBe('org-my-package-storage');
    });
  });
});

describe('deriveStateBucketName (state-bucket generation)', () => {
  it('embeds the generation after pulumi-state', async () => {
    const { deriveStateBucketName } = await import('../../../src/lib/providers/s3-base.js');
    expect(deriveStateBucketName('myapp-ab12cd-storage', 'f00baa')).toBe(
      'myapp-ab12cd-storage-pulumi-state-f00baa',
    );
  });

  it('legacy call without a generation stays byte-stable', async () => {
    const { deriveStateBucketName } = await import('../../../src/lib/providers/s3-base.js');
    expect(deriveStateBucketName('myapp-ab12cd-storage')).toBe('myapp-ab12cd-storage-pulumi-state');
  });

  it('the generation SURVIVES the 63-char clip on long project names (base clipped, suffix whole)', async () => {
    const { deriveStateBucketName } = await import('../../../src/lib/providers/s3-base.js');
    // Real e2e shape that used to truncate to `…-storage-pulumi-stat`.
    const long = 'testapp-k8s-ha-1786072543348-pkejma-9fbb81-storage';
    const name = deriveStateBucketName(long, 'f00baa');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/-pulumi-state-f00baa$/);
    // Distinct generations must yield distinct names even at max length —
    // that distinctness is the entire point (fresh name per generation).
    expect(deriveStateBucketName(long, 'abc123')).not.toBe(name);
  });
});
