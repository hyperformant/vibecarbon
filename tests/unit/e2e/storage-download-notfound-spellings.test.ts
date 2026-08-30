import { describe, expect, it } from 'vitest';
import { isStorageNotFoundResponse } from '../../e2e/checks/app-functional.js';

/**
 * The storage_download diagnostic retry (a NON-absorbing probe that names
 * which failure mode occurred — read-after-write race vs. genuinely missing
 * object) must fire on EVERY spelling of "not found" the storage path
 * produces, or the next occurrence yields no evidence again.
 *
 * Occurrence #1 (2026-08-23, run 32614839037, hetzner compose
 * verify-restore): outer HTTP 404 — the trigger this probe was built on.
 * Occurrence #2 (2026-08-30, run 33324819789, same step): outer HTTP 400
 * with storage-api's JSON body {"statusCode":"404","error":"Not found"} —
 * the trigger MISSED it and the run produced zero discriminating evidence.
 */
describe('isStorageNotFoundResponse', () => {
  it('matches the outer-404 spelling (occurrence #1)', () => {
    expect(isStorageNotFoundResponse(404, 'anything')).toBe(true);
  });

  it('matches the outer-400 + body statusCode 404 spelling (occurrence #2)', () => {
    expect(
      isStorageNotFoundResponse(
        400,
        '{"statusCode":"404","error":"Not found","message":"The resource was not found"}',
      ),
    ).toBe(true);
  });

  it('does not fire on unrelated failures', () => {
    expect(isStorageNotFoundResponse(500, 'Internal Server Error')).toBe(false);
    expect(isStorageNotFoundResponse(403, '{"statusCode":"403","error":"Forbidden"}')).toBe(false);
    // A body that merely mentions 404 in prose is not a not-found envelope.
    expect(isStorageNotFoundResponse(400, 'upstream said 404 things')).toBe(false);
  });
});
