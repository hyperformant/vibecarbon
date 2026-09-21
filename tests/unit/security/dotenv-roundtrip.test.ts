import { describe, expect, it } from 'vitest';
import { DotenvValueError, formatDotenvLine, parseDotenv } from '../../../src/lib/dotenv.js';
import { serializeDotenv } from '../../../src/lib/project.js';

describe('C-8 / H-14: dotenv round-trip preserves all characters', () => {
  it.each([
    ['SIMPLE', 'hello'],
    ['EMPTY', ''],
    ['WITH_SPACE', 'hello world'],
    ['WITH_QUOTE', "it's tricky"],
    ['WITH_DOUBLE_QUOTE', 'say "hi"'],
    ['WITH_DOLLAR', 'price=$100'],
    ['WITH_BACKSLASH', 'a\\b'],
    ['WITH_BACKTICK', 'back`tick'],
    ['WITH_NEWLINE', 'line1\nline2'],
    ['DOUBLE_AND_DOLLAR', `say "hi" for $5`],
  ])('round-trips %s = %j', (key, value) => {
    const text = `${formatDotenvLine(key, value)}\n`;
    const parsed = parseDotenv(text);
    expect(parsed[key]).toBe(value);
  });

  // A single quote together with any of `"` `\` `$` has no portable form
  // (2026-09-20 spec): the writer refuses, naming the key and never the value.
  it('refuses MIXED_PAYLOAD instead of approximating it', () => {
    const value = `shell"'\`$\\ends here`;
    let caught: unknown;
    try {
      serializeDotenv({ MIXED_PAYLOAD: value });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DotenvValueError);
    expect((caught as Error).message).toContain('MIXED_PAYLOAD');
    expect((caught as Error).message).not.toContain('ends here');
  });

  it('parses multiple keys in one file', () => {
    const text = serializeDotenv({ A: '1', B: '2', C: 'three' });
    const parsed = parseDotenv(text);
    expect(parsed).toEqual({ A: '1', B: '2', C: 'three' });
  });

  it('reads the three forms the writer emits: bare, "double", \'single\'', () => {
    const text = 'BARE=bar\nDOUBLE="two words"\nSINGLE=\'lit $X\'\n';
    expect(parseDotenv(text)).toEqual({ BARE: 'bar', DOUBLE: 'two words', SINGLE: 'lit $X' });
  });

  it('ignores comment lines and blank lines', () => {
    const text = "# header\n\nFOO='hello'\n# trailing\n";
    expect(parseDotenv(text)).toEqual({ FOO: 'hello' });
  });

  // Values that exercised parser termination bugs (trailing backslash,
  // combined quote + newline).
  it.each([
    ['TRAILING_BACKSLASH', 'path\\'],
    ['DOUBLE_TRAILING', '\\\\'],
    ['SINGLE_BACKSLASH', '\\'],
    ['QUOTE_AND_NEWLINE', "it's\nline two"],
    ['QUOTE_END', "ends in quote'"],
    ['NEWLINE_AND_QUOTES', "line1\n'line2'\nline3"],
  ])('round-trips tricky %s', (key, value) => {
    const text = `${formatDotenvLine(key, value)}\n`;
    const parsed = parseDotenv(text);
    expect(parsed[key]).toBe(value);
  });
});

describe('C-8: admin email/password validators reject metacharacter payloads', () => {
  it('(see validators.test.ts for exhaustive coverage; this is a structural check)', async () => {
    const { validateAdminEmail, validateAdminPassword } = await import(
      '../../../src/lib/validators.js'
    );
    // Smoke-test that the wires are still connected from T3.
    expect(validateAdminEmail("evil'@example.com")).toBeTruthy();
    expect(validateAdminPassword("Tr0ub'dour")).toBeTruthy();
  });
});
