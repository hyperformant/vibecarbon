import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setEnvVar } from '../../../src/lib/project.js';

describe('setEnvVar localOnly', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(
      tmpdir(),
      `vibecarbon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, '.env.local'), '');
    writeFileSync(join(projectDir, '.env'), '');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('default (no opts) writes both .env.local and .env — unchanged behavior', () => {
    setEnvVar('FOO', 'bar', projectDir);

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toContain("FOO='bar'");
    expect(readFileSync(join(projectDir, '.env'), 'utf-8')).toContain("FOO='bar'");
  });

  it('localOnly: true writes ONLY .env.local, leaving .env untouched', () => {
    setEnvVar('HETZNER_API_TOKEN', 'secret-token', projectDir, { localOnly: true });

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toContain(
      "HETZNER_API_TOKEN='secret-token'",
    );
    expect(readFileSync(join(projectDir, '.env'), 'utf-8')).toBe('');
  });

  it('localOnly: false is byte-identical to the default (both files written)', () => {
    setEnvVar('FOO', 'bar', projectDir, { localOnly: false });

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toContain("FOO='bar'");
    expect(readFileSync(join(projectDir, '.env'), 'utf-8')).toContain("FOO='bar'");
  });

  it('localOnly skips .env even when .env does not exist (no accidental creation)', () => {
    rmSync(join(projectDir, '.env'));

    setEnvVar('HETZNER_API_TOKEN', 'secret-token', projectDir, { localOnly: true });

    expect(existsSync(join(projectDir, '.env'))).toBe(false);
    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toContain(
      "HETZNER_API_TOKEN='secret-token'",
    );
  });

  it('localOnly updates an existing .env.local key in place, still ignoring .env', () => {
    writeFileSync(join(projectDir, '.env.local'), "HETZNER_API_TOKEN='old-token'\n");
    writeFileSync(join(projectDir, '.env'), "HETZNER_API_TOKEN='old-token'\n");

    setEnvVar('HETZNER_API_TOKEN', 'new-token', projectDir, { localOnly: true });

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toContain(
      "HETZNER_API_TOKEN='new-token'",
    );
    // .env keeps its stale value untouched — localOnly never writes it.
    expect(readFileSync(join(projectDir, '.env'), 'utf-8')).toContain(
      "HETZNER_API_TOKEN='old-token'",
    );
  });

  it('localOnly CREATES .env.local when absent (fresh clone: gitignored file never existed), owner-only 0o600', () => {
    rmSync(join(projectDir, '.env.local'));
    expect(existsSync(join(projectDir, '.env.local'))).toBe(false);

    setEnvVar('HETZNER_API_TOKEN', 'secret-token', projectDir, { localOnly: true });

    const envLocalPath = join(projectDir, '.env.local');
    expect(existsSync(envLocalPath)).toBe(true);
    expect(readFileSync(envLocalPath, 'utf-8')).toContain("HETZNER_API_TOKEN='secret-token'");
    // owner-only permissions — this file now holds a provider secret.
    expect(statSync(envLocalPath).mode & 0o777).toBe(0o600);
  });

  it('default (non-localOnly) path still SKIPS creation when both files are missing (pins existing behavior)', () => {
    rmSync(join(projectDir, '.env.local'));
    rmSync(join(projectDir, '.env'));

    setEnvVar('FOO', 'bar', projectDir);

    expect(existsSync(join(projectDir, '.env.local'))).toBe(false);
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });
});
