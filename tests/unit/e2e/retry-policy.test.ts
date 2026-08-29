import { describe, expect, it } from 'vitest';
import { decideFlakeRetry } from '../../e2e/utils/retry-policy.js';

/**
 * The retry-on-flake decision, pinned. The keep-blocks-retry rule shipped
 * untested on 2026-08-28 (fefc237) — a kept rig still owns the env prefix
 * the retry would redeploy into (Hetzner server names, DNS records, Pulumi
 * stacks), so retrying against it is a guaranteed collision. This table
 * closes that gap and pins the pre-existing policy around it.
 */
describe('decideFlakeRetry', () => {
  const base = { status: 'fail', failureCategory: 'infra' };

  it('retries an infra failure when armed and no keep flag is set', () => {
    expect(decideFlakeRetry({ ...base, env: { E2E_RETRY_FLAKES: '1' } })).toBe('retry');
  });

  it('is blocked by VC_KEEP_ON_FAILURE — kept rig owns the env prefix', () => {
    expect(
      decideFlakeRetry({ ...base, env: { E2E_RETRY_FLAKES: '1', VC_KEEP_ON_FAILURE: '1' } }),
    ).toBe('blocked-by-keep');
  });

  it('is blocked by VC_KEEP_ALWAYS the same way', () => {
    expect(decideFlakeRetry({ ...base, env: { E2E_RETRY_FLAKES: '1', VC_KEEP_ALWAYS: '1' } })).toBe(
      'blocked-by-keep',
    );
  });

  it('never retries when E2E_RETRY_FLAKES is not armed (opt-in only)', () => {
    expect(decideFlakeRetry({ ...base, env: {} })).toBe('no-retry');
  });

  it('never retries a pass', () => {
    expect(
      decideFlakeRetry({
        status: 'pass',
        failureCategory: 'infra',
        env: { E2E_RETRY_FLAKES: '1' },
      }),
    ).toBe('no-retry');
  });

  it("never retries 'unknown' (state left behind is unknown)", () => {
    expect(
      decideFlakeRetry({
        status: 'fail',
        failureCategory: 'unknown',
        env: { E2E_RETRY_FLAKES: '1' },
      }),
    ).toBe('no-retry');
  });

  it("never retries 'regression' (re-running won't fix code)", () => {
    expect(
      decideFlakeRetry({
        status: 'fail',
        failureCategory: 'regression',
        env: { E2E_RETRY_FLAKES: '1' },
      }),
    ).toBe('no-retry');
  });

  it('keep flags alone do not create retries (blocked only applies to a warranted retry)', () => {
    expect(
      decideFlakeRetry({
        status: 'fail',
        failureCategory: 'unknown',
        env: { VC_KEEP_ALWAYS: '1' },
      }),
    ).toBe('no-retry');
  });
});
