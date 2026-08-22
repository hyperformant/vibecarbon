import { describe, expect, it } from 'vitest';
import {
  escapeDotenv,
  escapeSql,
  escapeYaml,
  parseDotenv,
  shEscape,
  unescapeDotenv,
} from '../../../src/lib/shell.js';

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

describe('escapeDotenv', () => {
  it('produces single-quoted dotenv values with embedded-quote handling', () => {
    expect(escapeDotenv(`it's "quoted" and $dangerous`)).toBe(`'it'\\''s "quoted" and $dangerous'`);
  });

  it('keeps newlines literal inside single quotes', () => {
    expect(escapeDotenv('a\nb')).toBe("'a\nb'");
  });

  it('escapes newline + dollar combo as a single literal', () => {
    expect(escapeDotenv('line1\n$SECRET=injected')).toBe("'line1\n$SECRET=injected'");
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

describe('unescapeDotenv', () => {
  it('round-trips a simple value through escapeDotenv', () => {
    const v = 'ghcr.io/owner/repo:tag';
    expect(unescapeDotenv(escapeDotenv(v))).toBe(v);
  });

  it('round-trips a value with embedded single quotes', () => {
    const v = "it's complicated";
    expect(unescapeDotenv(escapeDotenv(v))).toBe(v);
  });

  it('round-trips a value with shell metacharacters', () => {
    const v = '$(echo pwn) `whoami` "quoted"';
    expect(unescapeDotenv(escapeDotenv(v))).toBe(v);
  });

  it('strips legacy double-quoted form without interpreting escapes', () => {
    expect(unescapeDotenv('"hello"')).toBe('hello');
  });

  it('passes bare unquoted values through', () => {
    expect(unescapeDotenv('localhost')).toBe('localhost');
  });

  it('handles empty quoted forms', () => {
    expect(unescapeDotenv("''")).toBe('');
    expect(unescapeDotenv('""')).toBe('');
  });

  it('treats null/undefined as empty string', () => {
    expect(unescapeDotenv(null as unknown as string)).toBe('');
    expect(unescapeDotenv(undefined as unknown as string)).toBe('');
  });
});

describe('parseDotenv', () => {
  it('parses canonical KEY=VALUE lines into a map', () => {
    const text = ['FOO=bar', 'BAZ=qux'].join('\n');
    expect(parseDotenv(text)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('decodes escapeDotenv-quoted values back to raw', () => {
    const text = [
      `APP_IMAGE=${escapeDotenv('ghcr.io/owner/repo:tag')}`,
      `SECRET=${escapeDotenv("it's a secret")}`,
    ].join('\n');
    expect(parseDotenv(text)).toEqual({
      APP_IMAGE: 'ghcr.io/owner/repo:tag',
      SECRET: "it's a secret",
    });
  });

  it('skips comments and blank lines', () => {
    const text = ['# header', '', 'FOO=bar', '# trailing'].join('\n');
    expect(parseDotenv(text)).toEqual({ FOO: 'bar' });
  });

  it('ignores lines that do not match KEY=VALUE', () => {
    const text = ['export FOO=bar', 'random text', 'lowercase=skipped', 'OK=yes'].join('\n');
    expect(parseDotenv(text)).toEqual({ OK: 'yes' });
  });

  it('returns an empty object for empty input', () => {
    expect(parseDotenv('')).toEqual({});
    expect(parseDotenv(null as unknown as string)).toEqual({});
  });

  it('round-trips a representative deploy-time .env shape', () => {
    // Exact subset of fields the orchestrator's renderBundle emits.
    const original: Record<string, string> = {
      PROJECT_NAME: 'myproj',
      APP_IMAGE: 'ghcr.io/owner/repo:abc123',
      DOMAIN: 'example.com',
      SITE_URL: 'https://api.example.com',
      S3_ACCESS_KEY: 'AKIA-with-symbols!@#',
      S3_SECRET_KEY: "secret-with-'-quote",
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOi...long.jwt-shaped.placeholder',
    };
    const text = Object.entries(original)
      .map(([k, v]) => `${k}=${escapeDotenv(v)}`)
      .join('\n');
    expect(parseDotenv(text)).toEqual(original);
  });
});
