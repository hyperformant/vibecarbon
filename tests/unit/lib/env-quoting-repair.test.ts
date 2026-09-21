/**
 * `repairLegacyEnvQuoting` (project.js): the entry-point hook every command
 * that reads `.env`/`.env.local` runs BEFORE its first read (final review
 * H1/M1, 2026-09-21). The repair used to live only at write time
 * (`setEnvVar`), so a read that came first acted on the truncated value —
 * configure's Enter-to-keep wrote it back, deploy's k8s path shipped it.
 * This wraps `healLegacyDotenvQuoting` with the one info line (key names
 * only) and the per-key warning; silent when there is nothing to say.
 * Fixture values only.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { readProjectEnvFiles, repairLegacyEnvQuoting } from '../../../src/lib/project.js';

function project(files: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'env-repair-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  return cwd;
}
const fakeLog = () => ({ info: vi.fn(), warn: vi.fn() });

describe('repairLegacyEnvQuoting', () => {
  it('heals both files before the caller reads them, and names the keys (never a value) once', () => {
    const cwd = project({
      '.env': "SMTP_PASS='pa'\\''ss'\nA=1\n",
      '.env.local': "SMTP_PASS='pa'\\''ss'\nTOKEN='t'\\''k'\n",
    });
    const log = fakeLog();
    const result = repairLegacyEnvQuoting(cwd, { log });
    expect(result.healed).toEqual(['SMTP_PASS', 'SMTP_PASS', 'TOKEN']);
    expect(readProjectEnvFiles(cwd)).toEqual({ SMTP_PASS: "pa'ss", A: '1', TOKEN: "t'k" });
    expect(log.info).toHaveBeenCalledTimes(1);
    const line = log.info.mock.calls[0][0] as string;
    expect(line).toBe('Re-encoded 2 legacy-quoted values in .env/.env.local: SMTP_PASS, TOKEN');
    expect(line).not.toContain('pa');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('singular form for one key', () => {
    const cwd = project({ '.env': "A='x'\\''y'\n" });
    const log = fakeLog();
    repairLegacyEnvQuoting(cwd, { log });
    expect(log.info).toHaveBeenCalledWith('Re-encoded 1 legacy-quoted value in .env/.env.local: A');
  });

  it('warns per skipped key with the reason and the configure hint, leaving the line in place', () => {
    const cwd = project({ '.env.local': `BAD='mix '\\'' and "'\n` });
    const log = fakeLog();
    const result = repairLegacyEnvQuoting(cwd, { log });
    expect(result.healed).toEqual([]);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const warn = log.warn.mock.calls[0][0] as string;
    expect(warn).toMatch(
      /^BAD: it mixes a single quote with .* — re-enter it with `vibecarbon configure`$/,
    );
    expect(warn).not.toContain('mix ');
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe(`BAD='mix '\\'' and "'\n`);
  });

  it('is silent and writes nothing on a portable project', () => {
    const local = 'A=1\nB="x y"\n';
    const cwd = project({ '.env.local': local });
    const log = fakeLog();
    expect(repairLegacyEnvQuoting(cwd, { log })).toEqual({ healed: [], skipped: [] });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(readFileSync(join(cwd, '.env.local'), 'utf-8')).toBe(local);
  });

  it('dryRun says what it would do and leaves the file byte-identical', () => {
    const env = "A='x'\\''y'\n";
    const cwd = project({ '.env': env });
    const log = fakeLog();
    const result = repairLegacyEnvQuoting(cwd, { dryRun: true, log });
    expect(result.healed).toEqual(['A']);
    expect(log.info).toHaveBeenCalledWith(
      'Would re-encode 1 legacy-quoted value in .env/.env.local: A (dry run)',
    );
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe(env);
    expect(parseDotenv(env)).toEqual({ A: 'x' }); // still the truncated read until a real run
  });
});
