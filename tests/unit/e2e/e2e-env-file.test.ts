import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadE2EEnvFile } from '../../../tests/e2e/utils/e2e-env-file.js';

describe('loadE2EEnvFile — A6 operator token file loader', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e2e-env-file-test-'));
    filePath = join(dir, '.env.e2e');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing file is a no-op: target is untouched, empty Set returned', () => {
    const target: NodeJS.ProcessEnv = { EXISTING: 'unchanged' };
    const applied = loadE2EEnvFile(join(dir, 'does-not-exist.env'), target);
    expect(applied.size).toBe(0);
    expect(target).toEqual({ EXISTING: 'unchanged' });
  });

  it('sets keys from the file into an empty target', () => {
    writeFileSync(filePath, "HETZNER_API_TOKEN='abc123'\nCLOUDFLARE_API_TOKEN='def456'\n");
    const target: NodeJS.ProcessEnv = {};
    const applied = loadE2EEnvFile(filePath, target);
    expect(target.HETZNER_API_TOKEN).toBe('abc123');
    expect(target.CLOUDFLARE_API_TOKEN).toBe('def456');
    expect(applied).toEqual(new Set(['HETZNER_API_TOKEN', 'CLOUDFLARE_API_TOKEN']));
  });

  it('real env wins: a key already present in target is never overwritten', () => {
    writeFileSync(filePath, "HETZNER_API_TOKEN='from-file'\n");
    const target: NodeJS.ProcessEnv = { HETZNER_API_TOKEN: 'from-shell' };
    const applied = loadE2EEnvFile(filePath, target);
    expect(target.HETZNER_API_TOKEN).toBe('from-shell');
    expect(applied.size).toBe(0);
  });

  it('sets only the keys present in the file — other target keys are untouched', () => {
    writeFileSync(filePath, "HETZNER_ACCESS_KEY='ak'\n");
    const target: NodeJS.ProcessEnv = { UNRELATED: 'stays' };
    loadE2EEnvFile(filePath, target);
    expect(target).toEqual({ UNRELATED: 'stays', HETZNER_ACCESS_KEY: 'ak' });
  });

  it('a mix of shell-set and file-only keys: only the gaps get filled', () => {
    writeFileSync(
      filePath,
      "HETZNER_API_TOKEN='file-token'\nHETZNER_ACCESS_KEY='file-ak'\nHETZNER_SECRET_KEY='file-sk'\n",
    );
    const target: NodeJS.ProcessEnv = { HETZNER_API_TOKEN: 'shell-token' };
    const applied = loadE2EEnvFile(filePath, target);
    expect(target.HETZNER_API_TOKEN).toBe('shell-token');
    expect(target.HETZNER_ACCESS_KEY).toBe('file-ak');
    expect(target.HETZNER_SECRET_KEY).toBe('file-sk');
    expect(applied).toEqual(new Set(['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY']));
  });

  it('empty file is a no-op', () => {
    writeFileSync(filePath, '');
    const target: NodeJS.ProcessEnv = {};
    const applied = loadE2EEnvFile(filePath, target);
    expect(applied.size).toBe(0);
    expect(target).toEqual({});
  });

  it('comment and blank lines are ignored, matching parseDotenv semantics', () => {
    writeFileSync(filePath, "# comment\n\nDOCKER_HUB_USERNAME='acme'\n");
    const target: NodeJS.ProcessEnv = {};
    loadE2EEnvFile(filePath, target);
    expect(target.DOCKER_HUB_USERNAME).toBe('acme');
  });

  it('defaults target to process.env when omitted', () => {
    writeFileSync(filePath, "E2E_ENV_FILE_TEST_KEY='present'\n");
    delete process.env.E2E_ENV_FILE_TEST_KEY;
    try {
      loadE2EEnvFile(filePath);
      expect(process.env.E2E_ENV_FILE_TEST_KEY).toBe('present');
    } finally {
      delete process.env.E2E_ENV_FILE_TEST_KEY;
    }
  });
});
