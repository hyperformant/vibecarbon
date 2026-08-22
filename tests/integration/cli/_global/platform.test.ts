/**
 * Platform compatibility tests
 *
 * Verifies that checkPlatform() guards against unsupported platforms
 * (native Windows) with a helpful WSL2 message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import after mocks are set up
import { checkPlatform } from '../../../../src/cli.js';

describe('checkPlatform', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with code 1 on win32', () => {
    checkPlatform('win32');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints a WSL2 message on win32', () => {
    checkPlatform('win32');
    const allOutput = errorSpy.mock.calls.flat().join(' ');
    expect(allOutput).toContain('WSL2');
  });

  it('does nothing on linux', () => {
    checkPlatform('linux');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does nothing on darwin', () => {
    checkPlatform('darwin');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
