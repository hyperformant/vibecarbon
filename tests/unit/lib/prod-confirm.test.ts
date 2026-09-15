import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  log: { warn: vi.fn(), error: vi.fn() },
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
  // The prompt-path tests pass `isTTY: true` explicitly: vitest has no stdin
  // TTY, and off a TTY the guard now fails fast instead of prompting (see the
  // 'off a TTY' block below).
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
    await confirmProdOrExit('prod', { actionLabel: 'restore', yes: true, isTTY: true });
    expect(mockText).toHaveBeenCalledTimes(1);
    const arg = mockText.mock.calls[0][0] as { message: string; validate: (v: string) => unknown };
    expect(arg.message).toContain('prod');
    // the validator rejects a wrong value and accepts the exact env
    expect(arg.validate('wrong')).toBeTruthy();
    expect(arg.validate('prod')).toBeUndefined();
  });

  it('uses a custom confirmValue when provided', async () => {
    mockText.mockResolvedValue('myapp-production');
    await confirmProdOrExit('production', { confirmValue: 'myapp-production', isTTY: true });
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
    await expect(confirmProdOrExit('prod', { yes: true, isTTY: true })).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
  });

  describe('-confirm <value> (scripted escape hatch)', () => {
    // vibecarbon-web prod move, 2026-09-15: `destroy prod -y` and
    // `restore prod -y -source latest` both opened the type-to-confirm prompt
    // under a runner with no TTY and hung there until the process was reaped.
    // A runbook has to be scriptable without weakening the gate: the operator
    // types the slug on the command line instead of at the prompt.
    it('skips the prompt when -confirm matches the expected value', async () => {
      await confirmProdOrExit('prod', { actionLabel: 'restore', confirm: 'prod' });
      expect(mockText).not.toHaveBeenCalled();
    });

    it('matches against confirmValue, not the env name, when one is given', async () => {
      await confirmProdOrExit('production', {
        confirmValue: 'myapp-production',
        confirm: 'myapp-production',
      });
      expect(mockText).not.toHaveBeenCalled();
    });

    it('exits(1) naming the expected value when -confirm is wrong — never falls through to the prompt', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      await expect(
        confirmProdOrExit('prod', { actionLabel: 'destroy', confirm: 'prd' }),
      ).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockText).not.toHaveBeenCalled();
      const msg = (p.log.error as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(String(msg)).toContain('-confirm prod');
      exitSpy.mockRestore();
    });

    it('is ignored for a non-production env (no gate to satisfy)', async () => {
      await confirmProdOrExit('staging', { confirm: 'wrong' });
      expect(mockText).not.toHaveBeenCalled();
    });
  });

  describe('off a TTY', () => {
    // clack cannot read an answer without stdin; before this the prompt
    // opened anyway and the process sat there. Fail fast, and say which flag
    // makes the invocation scriptable.
    it('exits(1) instead of opening a prompt it can never answer, naming -confirm', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      await expect(
        confirmProdOrExit('prod', { actionLabel: 'restore', yes: true, isTTY: false }),
      ).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockText).not.toHaveBeenCalled();
      const msg = (p.log.error as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(String(msg)).toMatch(/interactive terminal/i);
      expect(String(msg)).toContain('-confirm prod');
      exitSpy.mockRestore();
    });

    it('still passes with a matching -confirm (the whole point of the flag)', async () => {
      await confirmProdOrExit('prod', { confirm: 'prod', isTTY: false });
      expect(mockText).not.toHaveBeenCalled();
    });

    it('on a TTY with no -confirm it prompts exactly as before', async () => {
      mockText.mockResolvedValue('prod');
      await confirmProdOrExit('prod', { yes: true, isTTY: true });
      expect(mockText).toHaveBeenCalledTimes(1);
    });
  });
});
