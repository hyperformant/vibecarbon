import { describe, expect, it } from 'vitest';
import { escapeSql, escapeYaml, shEscape } from '../../../src/lib/shell.js';

// Dotenv reading/writing left this module on 2026-09-20 (src/lib/dotenv.js;
// tests/unit/lib/dotenv.test.ts). shEscape is for shell command lines only.

describe('shEscape', () => {
  it('wraps simple strings in single quotes', () => {
    expect(shEscape('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes via close-reopen', () => {
    expect(shEscape("it's")).toBe("'it'\\''s'");
  });

  it('passes dollar signs and backticks through literally', () => {
    expect(shEscape('$(echo pwn)')).toBe("'$(echo pwn)'");
    expect(shEscape('`echo pwn`')).toBe("'`echo pwn`'");
  });

  it('handles newlines and tabs', () => {
    expect(shEscape('line1\nline2')).toBe("'line1\nline2'");
  });

  it('handles the empty string', () => {
    expect(shEscape('')).toBe("''");
  });

  it('coerces non-string values via String(value)', () => {
    expect(shEscape(42 as unknown as string)).toBe("'42'");
  });
});

describe('escapeSql', () => {
  it('returns a complete SQL string literal with outer quotes', () => {
    expect(escapeSql('hello')).toBe("'hello'");
  });

  it('doubles embedded single quotes per Postgres rules', () => {
    expect(escapeSql("O'Brien")).toBe("'O''Brien'");
  });

  it('handles injection-style payloads as a single literal', () => {
    expect(escapeSql("'; DROP TABLE users;--")).toBe("'''; DROP TABLE users;--'");
  });

  it('leaves other characters untouched inside the literal', () => {
    expect(escapeSql('normal text')).toBe("'normal text'");
  });
});

describe('escapeYaml', () => {
  it('quotes a plain string', () => {
    expect(escapeYaml('simple')).toBe('"simple"');
  });

  it('escapes embedded double quotes', () => {
    expect(escapeYaml('has "quotes"')).toBe('"has \\"quotes\\""');
  });

  it('escapes embedded backslashes', () => {
    expect(escapeYaml('back\\slash')).toBe('"back\\\\slash"');
  });
});
