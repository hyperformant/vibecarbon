import { describe, expect, it } from 'vitest';
import { DB_IMAGE, DB_IMAGE_TAG, dbImageRef } from '../../../src/lib/images.js';

describe('db image ref', () => {
  it('is the pre-published multi-arch tag (no project/sha/timestamp)', () => {
    expect(DB_IMAGE).toBe('ghcr.io/hyperformant/postgres');
    expect(DB_IMAGE_TAG).toBe('17.11-walg3.0.9-r1');
    expect(dbImageRef()).toBe('ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r1');
  });
  it('ref is stable — never per-deploy unique', () => {
    expect(dbImageRef()).toBe(dbImageRef());
    expect(dbImageRef()).not.toMatch(/dirty|\d{14}/); // no -dirty / timestamp
  });
});
