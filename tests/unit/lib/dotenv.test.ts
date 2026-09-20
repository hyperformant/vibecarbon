import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DotenvValueError,
  dotenvValueProblem,
  encodeDotenvValue,
  formatDotenvLine,
  parseDotenv,
  readEnvFiles,
} from '../../../src/lib/dotenv.js';

describe('encodeDotenvValue grammar', () => {
  it('emits bare values for the safe alphabet', () => {
    expect(encodeDotenvValue('K', '')).toBe('');
    expect(encodeDotenvValue('K', 'abc+/=')).toBe('abc+/=');
    expect(encodeDotenvValue('K', 'https://x.y:8443/z@v,1%')).toBe('https://x.y:8443/z@v,1%');
    expect(encodeDotenvValue('K', 'eyJ.abc.def-_')).toBe('eyJ.abc.def-_');
  });
  it('double-quotes spaces, #, single quotes, unicode and newlines', () => {
    expect(encodeDotenvValue('K', 'with space')).toBe('"with space"');
    expect(encodeDotenvValue('K', 'has#hash')).toBe('"has#hash"');
    expect(encodeDotenvValue('K', "it's")).toBe('"it\'s"');
    expect(encodeDotenvValue('K', 'émoji ✓')).toBe('"émoji ✓"');
    expect(encodeDotenvValue('K', 'line1\nline2')).toBe('"line1\\nline2"');
    expect(encodeDotenvValue('K', ' lead and trail ')).toBe('" lead and trail "');
    expect(encodeDotenvValue('K', 'semi;colon*star!bang?q&amp')).toBe(
      '"semi;colon*star!bang?q&amp"',
    );
  });
  it('single-quotes values holding ", backslash or $', () => {
    expect(encodeDotenvValue('K', 'say "hi"')).toBe('\'say "hi"\'');
    expect(encodeDotenvValue('K', 'back\\slash')).toBe("'back\\slash'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal .env value/output asserted verbatim, not a JS template
    expect(encodeDotenvValue('K', 'cost $5 and ${X}')).toBe("'cost $5 and ${X}'");
  });
  it('refuses the unrepresentable, naming key and reason but never the value', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['PW', `both ' and "`, /single quote/],
      ['PW', "quote ' and $X", /single quote/],
      ['PW', 'nl\nand "q"', /newline/],
      ['PW', 'tab\there', /control character/],
      ['PW', 'cr\r', /control character/],
      ['VITE_PUBLIC_URL', 'https://x/$y', /Vite/],
    ];
    for (const [key, value, reason] of cases) {
      expect(dotenvValueProblem(key, value)).toMatch(reason);
      let err: unknown;
      try {
        encodeDotenvValue(key, value);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DotenvValueError);
      expect((err as DotenvValueError).key).toBe(key);
      expect((err as Error).message).toContain(key);
      expect((err as Error).message).not.toContain(value);
    }
  });
  it('accepts every representable value with a null problem', () => {
    expect(dotenvValueProblem('K', "it's")).toBeNull();
    expect(dotenvValueProblem('K', 'a $b')).toBeNull();
    expect(dotenvValueProblem('K', 42)).toBeNull();
  });
  it('formatDotenvLine joins key and encoded value', () => {
    expect(formatDotenvLine('A', 'x y')).toBe('A="x y"');
  });
});

describe('parseDotenv / readEnvFiles', () => {
  it('parses through util.parseEnv semantics', () => {
    const text = 'export A=1\n# c\nB="two words"\nC=\'lit $X\'\nD=bare # comment\n\nE=\n';
    expect(parseDotenv(text)).toEqual({ A: '1', B: 'two words', C: 'lit $X', D: 'bare', E: '' });
    expect(parseDotenv('')).toEqual({});
    expect(parseDotenv(undefined)).toEqual({});
  });
  it('round-trips everything the encoder accepts', () => {
    const values = [
      '',
      'plain',
      'with space',
      'has#hash',
      "it's",
      'say "hi"',
      'back\\slash',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal .env value asserted verbatim, not a JS template
      'a $b ${c}',
      'l1\nl2',
      'é ✓',
      ' pad ',
    ];
    const text = values.map((v, i) => formatDotenvLine(`K${i}`, v)).join('\n');
    const parsed = parseDotenv(text);
    values.forEach((v, i) => {
      expect(parsed[`K${i}`]).toBe(v);
    });
  });
  it('layers .env.local over .env and skips missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
    expect(readEnvFiles(dir)).toEqual({});
    writeFileSync(join(dir, '.env'), 'A=1\nB=from-env\n');
    writeFileSync(join(dir, '.env.local'), 'B=from-local\nC=3\n');
    expect(readEnvFiles(dir)).toEqual({ A: '1', B: 'from-local', C: '3' });
  });
});

describe('template copy is byte-identical', () => {
  it('carbon/scripts/lib/dotenv.js === src/lib/dotenv.js', async () => {
    const { readFileSync } = await import('node:fs');
    const root = join(import.meta.dirname, '..', '..', '..');
    expect(readFileSync(join(root, 'carbon/scripts/lib/dotenv.js'), 'utf-8')).toBe(
      readFileSync(join(root, 'src/lib/dotenv.js'), 'utf-8'),
    );
  });
});
