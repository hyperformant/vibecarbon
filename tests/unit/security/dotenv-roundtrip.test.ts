import { describe, expect, it } from 'vitest';
import { parseDotenv, serializeDotenv } from '../../../src/lib/project.js';

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
    ['MIXED_PAYLOAD', `shell"'\`$\\ends here`],
  ])('round-trips %s = %j', (key, value) => {
    const text = serializeDotenv({ [key]: value });
    const parsed = parseDotenv(text);
    expect(parsed[key]).toBe(value);
  });

  it('parses multiple keys in one file', () => {
    const text = serializeDotenv({ A: '1', B: '2', C: 'three' });
    const parsed = parseDotenv(text);
    expect(parsed).toEqual({ A: '1', B: '2', C: 'three' });
  });

  it('accepts legacy double-quoted input (backwards compat)', () => {
    const legacy = 'FOO="bar"\nBAZ="qux"\n';
    expect(parseDotenv(legacy)).toEqual({ FOO: 'bar', BAZ: 'qux' });
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
    const text = serializeDotenv({ [key]: value });
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
