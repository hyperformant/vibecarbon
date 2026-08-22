import { describe, expect, it } from 'vitest';

/**
 * Tests for the requireAal2 gating logic.
 * Re-implements the decision matrix from
 * carbon/src/server/middleware/requireAal2.ts (checkAal2) as a pure function,
 * following the same convention as require-plan.test.ts. The real, importing
 * tests live in carbon/tests/ — this mirror keeps the root pre-push gate
 * covering the logic.
 */

type Aal = 'aal1' | 'aal2' | null;

interface CheckAal2Context {
  user: { id: string } | null;
  aal: Aal;
  mfaGloballyEnabled: boolean;
}

interface CheckAal2Result {
  allowed: boolean;
  status?: number;
  body?: { error: string; current_aal?: string; aal_required?: string };
}

function checkAal2(ctx: CheckAal2Context): CheckAal2Result {
  if (!ctx.user) {
    return { allowed: false, status: 401, body: { error: 'Unauthorized' } };
  }
  if (ctx.aal === 'aal2') {
    return { allowed: true };
  }
  if (!ctx.mfaGloballyEnabled) {
    return { allowed: true };
  }
  return {
    allowed: false,
    status: 403,
    body: { error: 'mfa_required', current_aal: ctx.aal ?? 'aal1', aal_required: 'aal2' },
  };
}

const user = { id: 'u1' };

describe('requireAal2 decision matrix', () => {
  it('allows an aal2 session', () => {
    expect(checkAal2({ user, aal: 'aal2', mfaGloballyEnabled: true }).allowed).toBe(true);
  });

  it('blocks an aal1 session with 403 mfa_required when MFA is enabled', () => {
    const r = checkAal2({ user, aal: 'aal1', mfaGloballyEnabled: true });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'mfa_required', current_aal: 'aal1', aal_required: 'aal2' });
  });

  it('reports current_aal aal1 when the session has no aal claim', () => {
    const r = checkAal2({ user, aal: null, mfaGloballyEnabled: true });
    expect(r.body?.current_aal).toBe('aal1');
  });

  it('allows an aal1 session when MFA is globally disabled (gate inert)', () => {
    expect(checkAal2({ user, aal: 'aal1', mfaGloballyEnabled: false }).allowed).toBe(true);
  });

  it('returns 401 when there is no user', () => {
    const r = checkAal2({ user: null, aal: null, mfaGloballyEnabled: true });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(401);
  });
});
