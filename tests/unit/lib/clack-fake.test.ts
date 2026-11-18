/**
 * clackFake and quietClack (tests/_shared/clack-fake.ts): the two fakes tests
 * put in place of @clack/prompts. What matters is what each one leaves out. A
 * fake that grew a member its test did not name would let code reach a prompt
 * nobody expected and pass. These pins are what the registry rows in
 * shared-helper-consumers.test.ts point at as deep coverage.
 */
import { describe, expect, it, vi } from 'vitest';
import { clackFake, quietClack } from '../../_shared/clack-fake.js';

describe('clackFake', () => {
  it('holds a mock for each function named, and nothing else', () => {
    const fake = clackFake({ fns: ['select', 'cancel'] });
    expect(Object.keys(fake).sort()).toEqual(['cancel', 'select']);
    expect(vi.isMockFunction(fake.select)).toBe(true);
    expect(fake.select()).toBeUndefined();
  });

  it('a prompt the test did not name throws when the code under test calls it', () => {
    const fake = clackFake({ fns: ['select'] }) as unknown as Record<string, () => unknown>;
    expect(() => fake.confirm()).toThrow(TypeError);
    expect(() => fake.spinner()).toThrow(TypeError);
  });

  it('log holds only the methods named, and is absent when none are', () => {
    const fake = clackFake({ log: ['info', 'warn'] });
    expect(Object.keys(fake.log).sort()).toEqual(['info', 'warn']);
    expect(vi.isMockFunction(fake.log.info)).toBe(true);
    expect('log' in clackFake({ fns: ['text'] })).toBe(false);
  });

  it('spinner is there only when asked for, and hands out start, stop and message', () => {
    expect('spinner' in clackFake({ fns: ['text'] })).toBe(false);
    const fake = clackFake({ spinner: true });
    const s = fake.spinner();
    expect(Object.keys(s).sort()).toEqual(['message', 'start', 'stop']);
    expect(fake.spinner).toHaveBeenCalledTimes(1);
  });

  it('keeps each `with` member as the very thing it was given', () => {
    const isCancel = vi.fn(() => false);
    const confirm = vi.fn(async () => true);
    const fake = clackFake({ fns: ['text'], with: { isCancel, confirm } });
    expect(fake.isCancel).toBe(isCancel);
    expect(fake.confirm).toBe(confirm);
    expect(Object.keys(fake).sort()).toEqual(['confirm', 'isCancel', 'text']);
  });
});

describe('quietClack', () => {
  const actual = () => ({
    select: () => 'real select',
    note: () => 'real note',
    outro: () => 'real outro',
    spinner: () => 'real spinner',
    log: { info: () => 'real info', warn: () => 'real warn', message: () => 'real message' },
  });

  it('silences the log methods named and drops the rest of log', () => {
    const fake = quietClack(actual(), { log: ['info', 'warn'] }) as ReturnType<typeof actual>;
    expect(Object.keys(fake.log).sort()).toEqual(['info', 'warn']);
    expect(fake.log.info()).toBeUndefined();
    expect(() => fake.log.message()).toThrow(TypeError);
  });

  it('leaves every prompt, and every output function not named, as the real one', () => {
    const real = actual();
    const fake = quietClack(real, { log: ['info'], fns: ['note'] }) as ReturnType<typeof actual>;
    expect(fake.select).toBe(real.select);
    expect(fake.outro).toBe(real.outro);
    expect(fake.spinner).toBe(real.spinner);
    expect(fake.note()).toBeUndefined();
  });

  it('silences spinner only when asked', () => {
    const fake = quietClack(actual(), { log: [], spinner: true }) as unknown as {
      spinner: () => Record<string, () => unknown>;
    };
    const s = fake.spinner();
    expect(Object.keys(s).sort()).toEqual(['message', 'start', 'stop']);
    expect(s.start()).toBeUndefined();
  });

  it('does not change the module it was given', () => {
    const real = actual();
    quietClack(real, { log: ['info'], spinner: true, fns: ['note', 'outro'] });
    expect(real.note()).toBe('real note');
    expect(real.spinner()).toBe('real spinner');
    expect(Object.keys(real.log).sort()).toEqual(['info', 'message', 'warn']);
  });
});
