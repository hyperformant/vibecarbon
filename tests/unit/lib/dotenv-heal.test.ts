import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import {
  hasLegacyDotenvQuoting,
  healLegacyDotenvQuoting,
  healLegacyDotenvText,
} from '../../../src/lib/dotenv-heal.js';

describe('healLegacyDotenvText', () => {
  it("re-encodes POSIX '\\'' lines and leaves everything else byte-identical", () => {
    const input = [
      '# header',
      "PLAIN='fine as is'",
      "PW='it'\\''s'",
      'GEN="abc"',
      "TOKEN='a $b'",
      '',
    ].join('\n');
    const { text, healed, skipped } = healLegacyDotenvText(input);
    expect(healed).toEqual(['PW']);
    expect(skipped).toEqual([]);
    expect(text.split('\n')[2]).toBe('PW="it\'s"');
    expect(text.split('\n').filter((_, i) => i !== 2)).toEqual(
      input.split('\n').filter((_, i) => i !== 2),
    );
    expect(parseDotenv(text).PW).toBe("it's");
  });
  it('skips a legacy value the new grammar refuses, naming the key', () => {
    const { text, healed, skipped } = healLegacyDotenvText(`PW='mix '\\'' and "'\n`);
    expect(healed).toEqual([]);
    expect(skipped).toEqual([{ key: 'PW', reason: expect.stringMatching(/single quote/) }]);
    expect(text).toBe(`PW='mix '\\'' and "'\n`);
  });
  it('re-encodes a legacy value that starts or ends with a quote', () => {
    // Old writer's escaping of "abc'" (trailing quote): 'abc'\\'''
    const end = healLegacyDotenvText("PW='abc'\\'''\n");
    expect(end.healed).toEqual(['PW']);
    expect(end.text).toBe('PW="abc\'"\n');
    // Old writer's escaping of "'abc" (leading quote): ''\\''abc'
    const start = healLegacyDotenvText("PW=''\\''abc'\n");
    expect(start.healed).toEqual(['PW']);
    expect(start.text).toBe('PW="\'abc"\n');
  });
  it('is a no-op on already-portable text', () => {
    const input = 'A=1\nB="x y"\nC=\'$z\'\n';
    expect(healLegacyDotenvText(input)).toEqual({ text: input, healed: [], skipped: [] });
  });
});

describe('hasLegacyDotenvQuoting (read-only detection for status)', () => {
  it("names the keys of every line carrying the POSIX '\\'' sequence, in file order", () => {
    const text = [
      "A='fine'",
      "PW='it'\\''s'",
      'B=1',
      `MIX='a '\\'' "'`,
      "# note: 'x'\\''y'",
      '',
    ].join('\n');
    expect(hasLegacyDotenvQuoting(text)).toEqual(['PW', 'MIX']);
  });
  it('returns an empty list for portable text', () => {
    expect(hasLegacyDotenvQuoting('A=1\nB="x y"\nC=\'$z\'\n')).toEqual([]);
  });
});

describe('healLegacyDotenvQuoting (entry-point hook)', () => {
  it('rewrites .env and .env.local in place and reports per file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'legacy-'));
    writeFileSync(join(cwd, '.env'), "A='x'\\''y'\n");
    writeFileSync(join(cwd, '.env.local'), "B='ok'\n");
    const result = healLegacyDotenvQuoting(cwd);
    expect(result.healed).toEqual(['A']);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('A="x\'y"\n');
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe("B='ok'\n");
  });
  it('dryRun reports the same result but leaves both files byte-identical', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'legacy-dry-'));
    const env = "A='x'\\''y'\nBAD='mix '\\'' and \"'\n";
    const local = "C='c'\\''d'\n";
    writeFileSync(join(cwd, '.env'), env);
    writeFileSync(join(cwd, '.env.local'), local);
    const result = healLegacyDotenvQuoting(cwd, { dryRun: true });
    expect(result.healed).toEqual(['A', 'C']);
    expect(result.skipped).toEqual([{ key: 'BAD', reason: expect.stringMatching(/single quote/) }]);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe(env);
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe(local);
  });
  it('is a no-op when neither file exists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'legacy-none-'));
    expect(healLegacyDotenvQuoting(cwd)).toEqual({ healed: [], skipped: [] });
  });
});
