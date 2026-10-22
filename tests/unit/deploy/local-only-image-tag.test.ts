import { describe, expect, it } from 'vitest';
import { isLocalOnlyImageTag } from '../../../src/lib/deploy/compose/index.js';

describe('isLocalOnlyImageTag', () => {
  it('treats bare project tags as local-only', () => {
    expect(isLocalOnlyImageTag('myproj-app:local')).toBe(true);
    expect(isLocalOnlyImageTag('myproj-db:latest')).toBe(true);
  });

  it('treats registry paths as not local-only', () => {
    expect(isLocalOnlyImageTag('ghcr.io/owner/repo:abc123')).toBe(false);
    expect(isLocalOnlyImageTag('docker.io/library/postgres:15')).toBe(false);
    // Plain "owner/repo" form (Docker Hub shorthand) is also not local-only.
    expect(isLocalOnlyImageTag('library/postgres:15')).toBe(false);
  });

  it('returns false for empty / non-string inputs', () => {
    expect(isLocalOnlyImageTag('')).toBe(false);
    expect(isLocalOnlyImageTag(null as unknown as string)).toBe(false);
    expect(isLocalOnlyImageTag(undefined as unknown as string)).toBe(false);
  });
});
