import { vi } from 'vitest';

/**
 * Fakes for `@clack/prompts`, one shape for the two ways tests replace it.
 *
 * Both are narrow on purpose: a fake holds only what its test named. A prompt
 * or a log method the test did not name is not there, so code that reaches
 * one the test did not expect throws instead of passing quietly.
 */

type Mock = ReturnType<typeof vi.fn>;

interface ClackFakeParts<F extends string, L extends string, W> {
  /** Top-level functions, each a bare `vi.fn()` (`'select'`, `'note'`, `'cancel'`). */
  fns?: readonly F[];
  /** `log` methods, each a bare `vi.fn()`. Left out, the fake has no `log`. */
  log?: readonly L[];
  /** A `spinner()` that hands out `{ start, stop, message }` mocks. */
  spinner?: boolean;
  /** Anything with behaviour of its own, as written (`isCancel`, a `confirm` that answers yes). */
  with?: W;
}

/**
 * The whole module as mocks, for a test that drives and asserts on prompts.
 * Build it inside `vi.hoisted` so the `vi.mock` factory can return it:
 *
 *   const clackMock = await vi.hoisted(async () => {
 *     const { clackFake } = await import('../../_shared/clack-fake.js');
 *     return clackFake({ fns: ['select', 'cancel'], log: ['info'], with: { isCancel: vi.fn(() => false) } });
 *   });
 *   vi.mock('@clack/prompts', () => clackMock);
 */
export function clackFake<
  F extends string = never,
  L extends string = never,
  W extends Record<string, unknown> = Record<never, never>,
>(parts: ClackFakeParts<F, L, W>): Record<F, Mock> & { log: Record<L, Mock>; spinner: Mock } & W {
  const fake: Record<string, unknown> = {};
  for (const name of parts.fns ?? []) fake[name] = vi.fn();
  if (parts.spinner) {
    fake.spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }));
  }
  if (parts.log) fake.log = Object.fromEntries(parts.log.map((name) => [name, vi.fn()]));
  return Object.assign(fake, parts.with) as Record<F, Mock> & {
    log: Record<L, Mock>;
    spinner: Mock;
  } & W;
}

interface QuietClackParts {
  /** The `log` methods to silence. `log` is replaced whole: a method not named is gone. */
  log: readonly string[];
  /** Also silence `spinner()`. */
  spinner?: boolean;
  /** Top-level output functions to silence (`'note'`, `'outro'`, `'intro'`). */
  fns?: readonly string[];
}

/**
 * The real module with its output silenced, for a test that only wants a
 * quiet terminal. The prompts stay real. Call it from the `vi.mock` factory:
 *
 *   vi.mock('@clack/prompts', async (orig) =>
 *     (await import('../../_shared/clack-fake.js')).quietClack(await orig(), { log: ['info', 'warn'] }),
 *   );
 */
export function quietClack(actual: unknown, parts: QuietClackParts): Record<string, unknown> {
  const quiet = () => {};
  const fake: Record<string, unknown> = { ...(actual as Record<string, unknown>) };
  if (parts.spinner) fake.spinner = () => ({ start: quiet, stop: quiet, message: quiet });
  fake.log = Object.fromEntries(parts.log.map((name) => [name, quiet]));
  for (const name of parts.fns ?? []) fake[name] = quiet;
  return fake;
}
