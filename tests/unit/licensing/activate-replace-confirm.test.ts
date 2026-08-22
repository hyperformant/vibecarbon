/**
 * The last member of the cancel/decline class, pinned directly.
 *
 * `activate` is the one confirm site where the two answers genuinely differ.
 * Declining "Replace with a new license key?" IS the success path — the
 * operator has a working license and chose to keep it, so exit 0 is correct
 * and this is deliberately NOT swept into `exitDeclined()`. Ctrl-C/ESC is not
 * an answer at all and must not be reported as "kept your license on purpose".
 *
 * Neither source census can see this one: the decline branch ends with
 * `p.outro(...)` + `return`, which is how every normal command ends, so
 * widening a census to match that shape would flag the entire CLI. Hence a
 * behavioural test instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CANCEL = Symbol.for('cancel');

const clackMock = vi.hoisted(() => ({
  confirm: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => clackMock);

const licensingMock = vi.hoisted(() => ({
  getLicense: vi.fn(),
  activateLicense: vi.fn(),
  deactivateLicense: vi.fn(),
}));
vi.mock('../../../src/lib/licensing/index.js', () => licensingMock);
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: vi.fn() }));

import { runActivate } from '../../../src/activate.js';

/** An operator who already holds a working license. */
function withActiveLicense() {
  licensingMock.getLicense.mockReturnValue({
    active: true,
    displayName: 'Fullerene',
    customerId: 'cus_123',
  });
}

describe('activate — "Replace with a new license key?"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withActiveLicense();
  });

  it('an explicit "no" KEEPS the license and succeeds (exit 0, no exit call)', async () => {
    clackMock.confirm.mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('unexpected process.exit');
    }) as never);

    await expect(runActivate([])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(clackMock.outro).toHaveBeenCalledWith('Keeping current license.');
    // The decline must not fall through into activation.
    expect(licensingMock.activateLicense).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('a CANCEL exits 130 — never reported as "kept your license"', async () => {
    clackMock.confirm.mockResolvedValue(CANCEL);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(runActivate([])).rejects.toThrow('process.exit(130)');

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(clackMock.cancel).toHaveBeenCalled();
    // The distinction that matters: a cancel is NOT the keep-license outcome.
    expect(clackMock.outro).not.toHaveBeenCalledWith('Keeping current license.');
    expect(licensingMock.activateLicense).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
