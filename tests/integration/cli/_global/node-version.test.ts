/**
 * Node version guard tests
 *
 * Verifies checkNodeVersion() fails fast with a helpful message when the
 * runtime Node is below the engines floor. `engines.node` alone only WARNS on
 * install, so a too-old Node otherwise reaches a cryptic crash at deploy time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkNodeVersion } from '../../../../src/cli.js';

describe('checkNodeVersion', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with code 1 below the floor', () => {
    checkNodeVersion('20.11.0', '24.15.0');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when only the patch is below the floor', () => {
    checkNodeVersion('24.15.0', '24.15.1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('names the floor and the current version in the message', () => {
    checkNodeVersion('22.19.0', '24.15.0');
    const out = errorSpy.mock.calls.flat().join(' ');
    expect(out).toContain('24.15.0');
    expect(out).toContain('22.19.0');
  });

  it('does nothing when exactly at the floor', () => {
    checkNodeVersion('24.15.0', '24.15.0');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does nothing above the floor', () => {
    checkNodeVersion('26.0.0', '24.15.0');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('tolerates a leading v on the current version', () => {
    checkNodeVersion('v26.1.0', '24.15.0');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not block when the floor cannot be determined', () => {
    checkNodeVersion('18.0.0', null);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('resolves a real floor from package.json engines by default', () => {
    // Default floor is read from the package; a very old current must exit.
    checkNodeVersion('18.0.0');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
