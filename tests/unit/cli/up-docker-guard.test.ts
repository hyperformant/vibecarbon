import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDockerRunning } from '../../../src/up.js';

describe('assertDockerRunning', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exits with code 1 when Docker is not reachable', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    assertDockerRunning({ probe: () => false });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does nothing when Docker is reachable', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    assertDockerRunning({ probe: () => true });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
