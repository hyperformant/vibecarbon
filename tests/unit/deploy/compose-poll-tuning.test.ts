import { describe, expect, it } from 'vitest';
import { RESTORE_PROMOTE_POLL_MS } from '../../../src/lib/deploy/compose/index.js';

describe('RESTORE_PROMOTE_POLL_MS (restore-promote poll tightening)', () => {
  it('polls the post-restore promotion at 2s (tighter than the old flat 5s)', () => {
    expect(RESTORE_PROMOTE_POLL_MS).toBe(2000);
    expect(RESTORE_PROMOTE_POLL_MS).toBeLessThan(5000);
  });
});
