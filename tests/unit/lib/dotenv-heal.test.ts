import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { healLegacyDotenvText } from '../../../src/lib/dotenv-heal.js';
import { healLegacyDotenvQuoting } from '../../../src/upgrade.js';

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

describe('healLegacyDotenvQuoting (upgrade hook)', () => {
  it('rewrites .env and .env.local in place and reports per file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'legacy-'));
    writeFileSync(join(cwd, '.env'), "A='x'\\''y'\n");
    writeFileSync(join(cwd, '.env.local'), "B='ok'\n");
    const result = healLegacyDotenvQuoting(cwd);
    expect(result.healed).toEqual(['A']);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('A="x\'y"\n');
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe("B='ok'\n");
  });
});
