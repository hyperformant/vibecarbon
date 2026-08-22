import { describe, expect, it } from 'vitest';
import { resolveDbImageTag } from '../../../src/lib/deploy/k8s/k3s.js';
import { dbImageRef } from '../../../src/lib/images.js';

describe('resolveDbImageTag', () => {
  it('returns the pre-published multi-arch ref (no local build/sideload tag)', () => {
    expect(resolveDbImageTag()).toBe(dbImageRef());
    expect(resolveDbImageTag()).not.toMatch(/10\.0\.1\.1:5000|dirty/);
  });
});
