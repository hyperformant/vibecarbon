import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadE2EEnvFile, readE2EEnv } from '../../../tests/e2e/utils/e2e-env-file.js';
import { createTempDir } from '../../_shared/temp-dir.js';

describe('loadE2EEnvFile — A6 operator token file loader', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = createTempDir('e2e-env-file-test-');
    filePath = join(dir, '.env.e2e');
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

describe('readE2EEnv', () => {
  // The lookup the out-of-band tools use (sweep-project.ts,
  // sweep-stale-stacks-ci.ts, audit-residue.ts): the file with the real env
  // laid over it, in a new object.
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = createTempDir('read-e2e-env-');
    file = join(dir, '.env.e2e');
  });

  it('the real env wins over the file', () => {
    writeFileSync(file, "HETZNER_API_TOKEN='file-token'\nHETZNER_ACCESS_KEY='file-ak'\n");
    const env = readE2EEnv(file, { HETZNER_API_TOKEN: 'shell-token' });
    expect(env.HETZNER_API_TOKEN).toBe('shell-token');
    expect(env.HETZNER_ACCESS_KEY).toBe('file-ak');
  });

  it('a blank real value counts as unset and falls back to the file (CI passes unset secrets as empty strings)', () => {
    writeFileSync(file, "VULTR_STORAGE_REGION='ewr1'\n");
    const env = readE2EEnv(file, { VULTR_STORAGE_REGION: '' });
    expect(env.VULTR_STORAGE_REGION).toBe('ewr1');
  });

  it('a blank real value with nothing in the file stays unset', () => {
    writeFileSync(file, '');
    const env = readE2EEnv(file, { LINODE_API_TOKEN: '' });
    expect('LINODE_API_TOKEN' in env).toBe(false);
  });

  it('a missing file reads as the real env alone', () => {
    const env = readE2EEnv(join(dir, 'absent'), { SCALEWAY_SECRET_KEY: 'shell' });
    expect(env).toEqual({ SCALEWAY_SECRET_KEY: 'shell' });
  });

  it('changes neither the real env nor anything else: it returns a new object', () => {
    writeFileSync(file, "DOCKER_HUB_USERNAME='acme'\n");
    const real: NodeJS.ProcessEnv = { HOME: '/home/x' };
    const env = readE2EEnv(file, real);
    expect(real).toEqual({ HOME: '/home/x' });
    expect(env).toEqual({ HOME: '/home/x', DOCKER_HUB_USERNAME: 'acme' });
  });
});
