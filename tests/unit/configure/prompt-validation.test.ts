/**
 * `configure`'s two prompt helpers (promptText/promptSecret) validate through
 * the config-registry when the call site passes `options.entry`: the clack
 * `validate` callback normalizes the raw input (trims, unquotes, ...) then
 * checks its shape, and the helper RETURNS the normalized value — so what
 * `configure` writes to disk is the cleaned value, never the raw paste.
 *
 * A prompt without `entry` is unchanged from before this feature existed.
 *
 * The second describe block is a census: every promptText()/promptSecret()
 * call site in src/configure.js must pass `entry:`, or be a listed exception
 * with a one-line reason. As of this change every prompted value in that file
 * writes a key that IS in the registry, so the exceptions list is empty by
 * design — an exception added later without a genuine registry gap is a bug
 * in the mapping, not a legitimate exception.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registryEntry } from '../../../src/lib/config-registry.js';

const clackMock = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
}));
vi.mock('@clack/prompts', () => clackMock);

const { promptText, promptSecret } = await import('../../../src/configure.js');

beforeEach(() => {
  clackMock.text.mockReset();
  clackMock.password.mockReset();
  clackMock.isCancel.mockReset();
  clackMock.isCancel.mockImplementation((v: unknown) => v === Symbol.for('cancel'));
});

describe('promptText — validates through the registry when options.entry is given', () => {
  const STRIPE_SECRET_KEY = registryEntry('STRIPE_SECRET_KEY');

  it('rejects the wrong shape, naming the key and the observed length, never the value', async () => {
    clackMock.text.mockResolvedValue('sk_test_wontbeused');
    await promptText('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });

    const { validate } = clackMock.text.mock.calls[0][0];
    expect(validate('pk_test_x')).toBe(
      'STRIPE_SECRET_KEY looks wrong: expected sk_live_…, sk_test_… or a restricted rk_… key, got 9 characters',
    );
  });

  it('normalizes before validating (validate passes) and returns the normalized value', async () => {
    clackMock.text.mockResolvedValue(' "sk_test_abc" ');
    const result = await promptText('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });

    const { validate } = clackMock.text.mock.calls[0][0];
    expect(validate(' "sk_test_abc" ')).toBeUndefined();
    expect(result).toBe('sk_test_abc');
  });

  // M10: the hint keys off the RAW paste, which the helper threads through
  // separately from the normalized value it validates.
  it('a quote-wrapped INVALID paste is told about the quotes; a quote-wrapped VALID one just passes', async () => {
    clackMock.text.mockResolvedValue('sk_test_wontbeused');
    await promptText('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });

    const { validate } = clackMock.text.mock.calls[0][0];
    expect(validate('"pk_test_x"')).toBe(
      'STRIPE_SECRET_KEY looks wrong: expected sk_live_…, sk_test_… or a restricted rk_… key, got 9 characters — surrounding quotes?',
    );
    expect(validate('"sk_test_abc"')).toBeUndefined();
  });

  it('Enter on an existing value still keeps it, unvalidated', async () => {
    clackMock.text.mockResolvedValue(''); // simulates Enter with no new input
    const result = await promptText('Stripe secret key', 'sk_test_existing', {
      entry: STRIPE_SECRET_KEY,
    });

    const { validate } = clackMock.text.mock.calls[0][0];
    // The empty submit bypasses entry validation entirely (fallback is defined).
    expect(validate('')).toBeUndefined();
    expect(result).toBe('sk_test_existing');
  });

  it('without entry, behaves exactly as before: raw value returned, custom validate still runs', async () => {
    const customValidate = vi.fn((v: string) => (v === 'bad' ? 'nope' : undefined));
    clackMock.text.mockResolvedValue('  raw value  ');

    const result = await promptText('Some field', undefined, { validate: customValidate });

    const { validate } = clackMock.text.mock.calls[0][0];
    expect(validate('bad')).toBe('nope');
    expect(customValidate).toHaveBeenCalledWith('bad');
    // No entry: the raw, non-normalized value comes back untouched.
    expect(result).toBe('  raw value  ');
  });

  it('cancellation returns null', async () => {
    const cancelSymbol = Symbol.for('cancel');
    clackMock.text.mockResolvedValue(cancelSymbol);
    const result = await promptText('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });
    expect(result).toBeNull();
  });
});

describe('promptSecret — validates through the registry when options.entry is given', () => {
  const STRIPE_SECRET_KEY = registryEntry('STRIPE_SECRET_KEY');

  it('rejects the wrong shape, naming the key and the observed length, never the value', async () => {
    clackMock.password.mockResolvedValue('sk_test_wontbeused');
    await promptSecret('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });

    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate('pk_test_x')).toBe(
      'STRIPE_SECRET_KEY looks wrong: expected sk_live_…, sk_test_… or a restricted rk_… key, got 9 characters',
    );
  });

  it('normalizes before validating (validate passes) and returns the normalized value', async () => {
    clackMock.password.mockResolvedValue(' "sk_test_abc" ');
    const result = await promptSecret('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });

    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate(' "sk_test_abc" ')).toBeUndefined();
    expect(result).toBe('sk_test_abc');
  });

  it('a quote-wrapped INVALID paste is told about the quotes; a quote-wrapped VALID one just passes', async () => {
    clackMock.password.mockResolvedValue('sk_test_wontbeused');
    await promptSecret('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });

    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate('"pk_test_x"\n')).toBe(
      'STRIPE_SECRET_KEY looks wrong: expected sk_live_…, sk_test_… or a restricted rk_… key, got 9 characters — a trailing newline?',
    );
    expect(validate('"sk_test_abc"')).toBeUndefined();
  });

  it('Enter on an existing value still keeps it, unvalidated', async () => {
    clackMock.password.mockResolvedValue('');
    const result = await promptSecret('Stripe secret key', 'sk_test_existing', {
      entry: STRIPE_SECRET_KEY,
    });

    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate('')).toBeUndefined();
    expect(result).toBe('sk_test_existing');
  });

  it('without entry, behaves exactly as before: required only when there is no current value', async () => {
    clackMock.password.mockResolvedValue('raw-secret');
    const result = await promptSecret('Some secret', undefined);

    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate('')).toBe('This field is required');
    // No entry: no shape check on a non-empty value.
    expect(validate('anything')).toBeUndefined();
    expect(result).toBe('raw-secret');
  });

  it('cancellation returns null', async () => {
    const cancelSymbol = Symbol.for('cancel');
    clackMock.password.mockResolvedValue(cancelSymbol);
    const result = await promptSecret('Stripe secret key', undefined, { entry: STRIPE_SECRET_KEY });
    expect(result).toBeNull();
  });
});

describe('promptText with an optional, shapeless registry entry (PADDLE_PRICE_PRO)', () => {
  // Single-tier billing is supported (carbon/src/server/routes/v1/billing.ts
  // builds the price map per tier conditionally), so this key is
  // `optional: true` in the registry with no `shape` at all (kind: 'id').
  const PADDLE_PRICE_PRO = registryEntry('PADDLE_PRICE_PRO');

  it('accepts an empty submit (optional) and returns the empty string', async () => {
    clackMock.text.mockResolvedValue('');
    const result = await promptText('Paddle price ID for Pro plan', undefined, {
      entry: PADDLE_PRICE_PRO,
    });

    const { validate } = clackMock.text.mock.calls[0][0];
    expect(validate('')).toBeUndefined();
    expect(result).toBe('');
  });

  it('normalizes a quoted value but does not reject it — the key carries no shape to reject against', async () => {
    clackMock.text.mockResolvedValue('"pri_123abc"');
    const result = await promptText('Paddle price ID for Pro plan', undefined, {
      entry: PADDLE_PRICE_PRO,
    });

    const { validate } = clackMock.text.mock.calls[0][0];
    // No shape on this entry, so even obviously-wrong-looking input is
    // accepted once normalized — "rejects only if a shape exists".
    expect(validate('"garbage but still normalizable"')).toBeUndefined();
    expect(result).toBe('pri_123abc');
  });
});

describe('promptSecret — Minor fix: defers to validateOperatorValue when entry is present', () => {
  // Inline registry-entry-shaped fixture (not a real CONFIG_KEYS entry) so
  // this test is not coupled to which real secrets happen to be optional.
  const OPTIONAL_SECRET = {
    key: 'FAKE_OPTIONAL_SECRET',
    class: 'runtime-secret',
    feature: 'test',
    kind: 'secret',
    optional: true,
    where: '.env',
    scope: 'test',
  };

  it('accepts an empty submit with no current value — optional entries are not force-required', async () => {
    clackMock.password.mockResolvedValue('');
    const result = await promptSecret('Optional secret', undefined, { entry: OPTIONAL_SECRET });

    const { validate } = clackMock.password.mock.calls[0][0];
    // Before the fix, the hardcoded "This field is required" check ran
    // BEFORE the entry branch and would have rejected this unconditionally.
    expect(validate('')).toBeUndefined();
    expect(result).toBe('');
  });

  it('an entry-less prompt still hardcodes "This field is required" on empty with no current value', async () => {
    clackMock.password.mockResolvedValue('anything');
    await promptSecret('Some secret', undefined);

    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate('')).toBe('This field is required');
  });
});

describe('configure prompt-site census — every registered-key prompt validates through the registry', () => {
  const src = readFileSync(join(process.cwd(), 'src/configure.js'), 'utf-8');

  /**
   * Exceptions to "every promptText()/promptSecret() call site passes
   * `entry:`", each with the one-line reason it's exempt. Empty by design:
   * every current call site writes a key that IS in the registry (see
   * task-6-report.md for the full call-site -> key -> entry table).
   */
  const EXCEPTIONS: Record<number, string> = {};

  function callSites(fnName: string): Array<{ line: number; text: string }> {
    const sites: Array<{ line: number; text: string }> = [];
    const declRegex = new RegExp(`^\\s*(export\\s+)?(async\\s+)?function\\s+${fnName}\\s*\\(`);
    const pattern = new RegExp(`\\b${fnName}\\(`, 'g');
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((m = pattern.exec(src))) {
      const start = m.index;
      const lineStart = src.lastIndexOf('\n', start) + 1;
      const lineEndIdx = src.indexOf('\n', start);
      const lineText = src.slice(lineStart, lineEndIdx === -1 ? src.length : lineEndIdx);
      if (declRegex.test(lineText)) continue; // skip the function's own declaration

      const openParenIndex = start + fnName.length;
      let depth = 1;
      let i = openParenIndex + 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
        i += 1;
      }
      const text = src.slice(start, i);
      const line = src.slice(0, start).split('\n').length;
      sites.push({ line, text });
    }
    return sites;
  }

  it('scanner finds every call site (guards the matcher)', () => {
    const sites = [...callSites('promptText'), ...callSites('promptSecret')];
    // 27 call sites enumerated by hand while implementing this task; this
    // floor also catches the scanner accidentally matching the declarations.
    expect(sites.length).toBeGreaterThanOrEqual(27);
  });

  it('every promptText()/promptSecret() call site passes `entry:`, or is a listed exception', () => {
    const sites = [...callSites('promptText'), ...callSites('promptSecret')].sort(
      (a, b) => a.line - b.line,
    );

    const offenders = sites
      .filter((s) => !/entry\s*:/.test(s.text))
      .filter((s) => !(s.line in EXCEPTIONS))
      .map((s) => `line ${s.line}: ${s.text.split('\n')[0]}…`);

    expect(
      offenders,
      `Missing entry: (and no EXCEPTIONS reason):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('EXCEPTIONS cannot rot: every listed line is still a real call site', () => {
    const liveLines = new Set(
      [...callSites('promptText'), ...callSites('promptSecret')].map((s) => s.line),
    );
    const stale = Object.keys(EXCEPTIONS)
      .map(Number)
      .filter((line) => !liveLines.has(line));
    expect(
      stale,
      'EXCEPTIONS lists a line that is no longer a promptText/promptSecret call',
    ).toEqual([]);
  });
});
