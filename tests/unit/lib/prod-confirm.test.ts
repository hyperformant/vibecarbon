import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  log: { warn: vi.fn() },
}));

import * as p from '@clack/prompts';
import { confirmProdOrExit, requiresProdTypeToConfirm } from '../../../src/lib/prod-confirm.js';

const mockText = p.text as unknown as ReturnType<typeof vi.fn>;
const mockIsCancel = p.isCancel as unknown as ReturnType<typeof vi.fn>;

describe('requiresProdTypeToConfirm', () => {
  it.each(['prod', 'Prod', 'PROD', 'production', 'Production', 'PRODUCTION'])(
    'returns true for %s',
    (env) => {
      expect(requiresProdTypeToConfirm(env)).toBe(true);
    },
  );

  it.each(['staging', 'dev', 'qa', 'preview', 'prod-backup', 'production-us', '', null, undefined])(
    'returns false for %s',
    (env) => {
      expect(requiresProdTypeToConfirm(env as string)).toBe(false);
    },
  );
});

describe('confirmProdOrExit', () => {
  beforeEach(() => {
    mockText.mockReset();
    mockIsCancel.mockReset().mockReturnValue(false);
  });

  it('does NOT prompt for a non-production env', async () => {
    await confirmProdOrExit('staging', { yes: true });
    expect(mockText).not.toHaveBeenCalled();
  });

  it('prompts type-to-confirm for prod even when -y is passed', async () => {
    // This is the core `restore -y prod` protection: -y skips the soft confirm
    // but NOT this hard gate.
    mockText.mockResolvedValue('prod');
    await confirmProdOrExit('prod', { actionLabel: 'restore', yes: true });
    expect(mockText).toHaveBeenCalledTimes(1);
    const arg = mockText.mock.calls[0][0] as { message: string; validate: (v: string) => unknown };
    expect(arg.message).toContain('prod');
    // the validator rejects a wrong value and accepts the exact env
    expect(arg.validate('wrong')).toBeTruthy();
    expect(arg.validate('prod')).toBeUndefined();
  });

  it('uses a custom confirmValue when provided', async () => {
    mockText.mockResolvedValue('myapp-production');
    await confirmProdOrExit('production', { confirmValue: 'myapp-production' });
    const arg = mockText.mock.calls[0][0] as { validate: (v: string) => unknown };
    expect(arg.validate('production')).toBeTruthy();
    expect(arg.validate('myapp-production')).toBeUndefined();
  });

  it('exits(130) when the operator cancels the prompt', async () => {
    mockText.mockResolvedValue(Symbol('cancel'));
    mockIsCancel.mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(confirmProdOrExit('prod', { yes: true })).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });
});
