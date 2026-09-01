import { describe, expect, it } from 'vitest';
import { DB_IMAGE, DB_IMAGE_TAG, dbImageRef } from '../../../src/lib/images.js';

describe('db image ref', () => {
  it('is the pre-published amd64 tag (no project/sha/timestamp)', () => {
    expect(DB_IMAGE).toBe('ghcr.io/hyperformant/postgres');
    expect(DB_IMAGE_TAG).toBe('17.6.1.167-walg3.0.9');
    expect(dbImageRef()).toBe('ghcr.io/hyperformant/postgres:17.6.1.167-walg3.0.9');
  });
  it('ref is stable — never per-deploy unique', () => {
    expect(dbImageRef()).toBe(dbImageRef());
    expect(dbImageRef()).not.toMatch(/dirty|\d{14}/); // no -dirty / timestamp
  });
});
