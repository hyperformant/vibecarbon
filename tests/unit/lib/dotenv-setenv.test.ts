import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DotenvValueError, parseDotenv } from '../../../src/lib/dotenv.js';
import { setEnvVar } from '../../../src/lib/project.js';

function project(env: string, local: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'setenv-'));
  writeFileSync(join(cwd, '.env'), env);
  writeFileSync(join(cwd, '.env.local'), local);
  return cwd;
}

describe('setEnvVar writes the portable grammar', () => {
  it('replaces bare, double-quoted and single-quoted existing lines', () => {
    const cwd = project('A=1\nB="two"\nC=\'$3\'\n', '');
    setEnvVar('A', 'x y', cwd);
    setEnvVar('B', 'say "hi"', cwd);
    setEnvVar('C', 'bare', cwd);
    const env = readFileSync(join(cwd, '.env'), 'utf-8');
    expect(env).toBe('A="x y"\nB=\'say "hi"\'\nC=bare\n');
    expect(parseDotenv(env)).toEqual({ A: 'x y', B: 'say "hi"', C: 'bare' });
  });
  it('appends when the key is absent and keeps other lines verbatim', () => {
    const cwd = project('# keep\nA=1\n', '');
    setEnvVar('NEW', "it's", cwd);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('# keep\nA=1\nNEW="it\'s"\n');
  });
  it("repairs legacy '\\'' lines in the file it touches", () => {
    const cwd = project("OLD='a'\\''b'\nA=1\n", '');
    setEnvVar('A', '2', cwd);
    expect(parseDotenv(readFileSync(join(cwd, '.env'), 'utf-8'))).toEqual({ OLD: "a'b", A: '2' });
  });
  it('refuses an unrepresentable value before writing anything', () => {
    const cwd = project('A=1\n', 'A=1\n');
    expect(() => setEnvVar('A', `mix ' and "`, cwd)).toThrow(DotenvValueError);
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('A=1\n');
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe('A=1\n');
  });
  it('localOnly creates .env.local and leaves .env alone', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'setenv-'));
    writeFileSync(join(cwd, '.env'), 'A=1\n');
    setEnvVar('T', 'tok', cwd, { localOnly: true });
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('A=1\n');
    expect(parseDotenv(readFileSync(join(cwd, '.env.local'), 'utf-8'))).toEqual({ T: 'tok' });
  });
});
