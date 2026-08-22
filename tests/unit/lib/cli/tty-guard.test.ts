import { describe, expect, it, vi } from 'vitest';
import { requireTTYOrFlags } from '../../../../src/lib/cli/tty-guard.js';

function makeStubs() {
  const stderrChunks: string[] = [];
  const stderr = {
    write: vi.fn((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  const exit = vi.fn((_code: number) => {
    throw new Error('process.exit called');
  }) as unknown as (code: number) => never;
  return { stderr, exit, stderrChunks };
}

describe('requireTTYOrFlags', () => {
  it('is a no-op on a TTY regardless of unsatisfied requirements', () => {
    const { stderr, exit } = makeStubs();
    expect(() =>
      requireTTYOrFlags({
        requirements: [{ flag: 'env', description: 'select env', satisfied: false }],
        stdin: { isTTY: true } as unknown as NodeJS.ReadStream,
        stderr,
        exit,
      }),
    ).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('is a no-op off a TTY when every requirement is already satisfied', () => {
    const { stderr, exit } = makeStubs();
    expect(() =>
      requireTTYOrFlags({
        requirements: [
          { flag: 'env', description: 'select env', satisfied: true },
          { flag: 'action', description: 'select action', satisfied: true },
        ],
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stderr,
        exit,
      }),
    ).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('exits 1 off a TTY when at least one requirement is unsatisfied', () => {
    const { stderr, exit, stderrChunks } = makeStubs();
    expect(() =>
      requireTTYOrFlags({
        requirements: [
          { flag: 'env', description: 'select an environment', satisfied: false },
          { flag: 'action', description: 'choose an action', satisfied: false },
        ],
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stderr,
        exit,
      }),
    ).toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    const message = stderrChunks.join('');
    expect(message).toContain('needs an interactive terminal');
    expect(message).toContain('-env');
    expect(message).toContain('select an environment');
    expect(message).toContain('-action');
    expect(message).toContain('choose an action');
  });

  it('only names the unsatisfied flags', () => {
    const { stderr, exit, stderrChunks } = makeStubs();
    expect(() =>
      requireTTYOrFlags({
        requirements: [
          { flag: 'env', description: 'select env', satisfied: true },
          { flag: 'action', description: 'choose action', satisfied: false },
        ],
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stderr,
        exit,
      }),
    ).toThrow('process.exit called');

    const message = stderrChunks.join('');
    // Only the unsatisfied flag should appear in the "needs these flags" list.
    expect(message).toContain('-action');
    // Crude check: the satisfied flag's description shouldn't be in the
    // prompt-list section. The flag name `-env` is short and could
    // appear elsewhere in the message; assert on the description
    // instead, which is unique.
    expect(message).not.toContain('select env');
  });
});
