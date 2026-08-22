import { describe, expect, it } from 'vitest';
import { shouldAutoDetectOperatorIp } from '../../../src/lib/operator-ip.js';

describe('shouldAutoDetectOperatorIp', () => {
  it('always auto-detects in interactive mode', () => {
    expect(shouldAutoDetectOperatorIp({ yes: false, env: {} })).toBe(true);
    expect(shouldAutoDetectOperatorIp({ yes: false, env: { CI: 'true' } })).toBe(true);
  });

  it('auto-detects for a non-interactive (-y) deploy from a real machine (NOT CI)', () => {
    // The bug: a `deploy -y` from a new network silently skipped auto-detect and
    // locked the operator out. -y means "don't prompt", not "don't protect".
    expect(shouldAutoDetectOperatorIp({ yes: true, env: {} })).toBe(true);
  });

  it('does NOT auto-detect under -y in CI (ephemeral runner IPs must not pollute the list)', () => {
    expect(shouldAutoDetectOperatorIp({ yes: true, env: { CI: 'true' } })).toBe(false);
    expect(shouldAutoDetectOperatorIp({ yes: true, env: { CI: '1' } })).toBe(false);
  });
});
