import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  log: { error: vi.fn(), info: vi.fn() },
  select: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === '__CANCEL__'),
}));

const originalExit = process.exit;

beforeEach(() => {
  vi.clearAllMocks();
  process.exit = vi.fn((_code?: number) => {
    throw new Error(`process.exit:${_code}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
});

const choices = [
  { value: 'create', label: 'Create a new backup' },
  { value: 'list', label: 'List existing backups' },
  { value: 'download', label: 'Download a backup' },
];

describe('selectAction', () => {
  it('returns the seeded action when it matches a known choice', async () => {
    const { selectAction } = await import('../../../../src/lib/cli/select-action.js');
    const p = await import('@clack/prompts');
    const result = await selectAction({
      message: 'What do you want to do?',
      choices,
      seed: 'list',
    });
    expect(result).toBe('list');
    expect(p.select).not.toHaveBeenCalled();
  });

  it('exits 1 when the seeded action is unknown', async () => {
    const { selectAction } = await import('../../../../src/lib/cli/select-action.js');
    const p = await import('@clack/prompts');
    await expect(
      selectAction({
        message: 'What do you want to do?',
        choices,
        seed: 'nuke',
      }),
    ).rejects.toThrow('process.exit:1');
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/Action 'nuke'.*not valid.*create.*list.*download/),
    );
  });

  it('skips the prompt when only one choice is available', async () => {
    const { selectAction } = await import('../../../../src/lib/cli/select-action.js');
    const p = await import('@clack/prompts');
    const result = await selectAction({
      message: 'What do you want to do?',
      choices: [{ value: 'restore', label: 'Restore' }],
      seed: null,
    });
    expect(result).toBe('restore');
    expect(p.select).not.toHaveBeenCalled();
  });

  it('prompts when seed is null and multiple choices exist', async () => {
    const p = await import('@clack/prompts');
    (p.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce('download');
    const { selectAction } = await import('../../../../src/lib/cli/select-action.js');
    const result = await selectAction({
      message: 'What do you want to do?',
      choices,
      seed: null,
    });
    expect(result).toBe('download');
    expect(p.select).toHaveBeenCalledTimes(1);
  });

  it('exits 130 when the operator cancels the prompt', async () => {
    const p = await import('@clack/prompts');
    (p.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce('__CANCEL__');
    const { selectAction } = await import('../../../../src/lib/cli/select-action.js');
    await expect(
      selectAction({
        message: 'What do you want to do?',
        choices,
        seed: null,
      }),
    ).rejects.toThrow('process.exit:130');
    expect(p.cancel).toHaveBeenCalled();
  });

  it('throws on empty choices (programming error, not user error)', async () => {
    const { selectAction } = await import('../../../../src/lib/cli/select-action.js');
    await expect(selectAction({ message: 'x', choices: [], seed: null })).rejects.toThrow(
      /no choices.*programming error/,
    );
  });
});
