/**
 * Unit tests for src/lib/github-environments.js. Mocks `runCommandAsync` so
 * no real `gh` calls are made; verifies the argv passed. The module lists
 * names at GitHub and writes only the build workflow's repo variables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';

const runCommandAsyncMock = vi.fn();

vi.mock('../../../src/lib/command.js', () => ({
  runCommandAsync: runCommandAsyncMock,
}));

async function freshImport() {
  // Reset module cache so mocks are re-applied on each import.
  vi.resetModules();
  return import('../../../src/lib/github-environments.js');
}

describe('github-environments', () => {
  beforeEach(() => {
    runCommandAsyncMock.mockReset();
    runCommandAsyncMock.mockImplementation(async () => '');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('writes', () => {
    it('writes no secret anywhere, and starts no workflow: the one write is the build workflow repo variables', async () => {
      // The per-environment seeding and the kubeconfig upload went with
      // deploy.yml; the last repo-level secret, the Hetzner token for its
      // kube-system/hcloud step, went before them
      // (tests/unit/deploy/gitops-provider-token.test.ts).
      const src = readRepoFile('src/lib/github-environments.js');
      expect(src).not.toMatch(/'secret',\s*'set'/);
      expect(src).not.toMatch(/'workflow',\s*'run'/);
      expect(src).not.toMatch(/'api'/);
      expect([...src.matchAll(/'variable',\s*'set'/g)]).toHaveLength(1);
      const { seedBuildVars } = await freshImport();
      expect(
        await seedBuildVars({ VITE_PUBLIC_URL: 'https://x.test', VITE_EMPTY: '', OTHER: 'y' }),
      ).toEqual(['VITE_PUBLIC_URL']);
      expect(runCommandAsyncMock.mock.calls).toEqual([
        [
          ['gh', 'variable', 'set', 'VITE_PUBLIC_URL', '--body', 'https://x.test'],
          { cleanEnv: true, silent: true },
        ],
      ]);
    });
  });

  describe('listEnvironmentVariables', () => {
    it('lists the variable names of an environment, bounded by the timeout', async () => {
      runCommandAsyncMock.mockImplementation(async () => 'SITE_URL\nTLS_CERT_ISSUER\n');
      const { listEnvironmentVariables } = await freshImport();
      expect(await listEnvironmentVariables('prod-primary', { timeout: 5000 })).toEqual([
        'SITE_URL',
        'TLS_CERT_ISSUER',
      ]);
      expect(runCommandAsyncMock.mock.calls[0]).toEqual([
        ['gh', 'variable', 'list', '--env', 'prod-primary', '--json', 'name', '-q', '.[].name'],
        { cleanEnv: true, silent: true, timeout: 5000 },
      ]);
    });

    it('an environment that does not exist has no variables; any other failure throws', async () => {
      const { listEnvironmentVariables } = await freshImport();
      runCommandAsyncMock.mockImplementation(async () => {
        throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 404: Not Found' });
      });
      expect(await listEnvironmentVariables('nope')).toEqual([]);
      runCommandAsyncMock.mockImplementation(async () => {
        throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 502: Bad Gateway' });
      });
      await expect(listEnvironmentVariables('prod')).rejects.toThrow('Command failed');
    });
  });

  describe('listEnvironmentSecretNames', () => {
    it('lists the secret names of an environment, bounded by the timeout; a missing environment has none', async () => {
      runCommandAsyncMock.mockImplementation(async () => 'KUBECONFIG_B64\nDB_PASSWORD\n');
      const { listEnvironmentSecretNames } = await freshImport();
      expect(await listEnvironmentSecretNames('prod-primary', { timeout: 5000 })).toEqual([
        'KUBECONFIG_B64',
        'DB_PASSWORD',
      ]);
      // Names only: GitHub never returns a secret's value.
      expect(runCommandAsyncMock.mock.calls[0]).toEqual([
        ['gh', 'secret', 'list', '--env', 'prod-primary', '--json', 'name', '-q', '.[].name'],
        { cleanEnv: true, silent: true, timeout: 5000 },
      ]);
      runCommandAsyncMock.mockImplementation(async () => {
        throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 404: Not Found' });
      });
      expect(await listEnvironmentSecretNames('nope')).toEqual([]);
      runCommandAsyncMock.mockImplementation(async () => {
        throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 502: Bad Gateway' });
      });
      await expect(listEnvironmentSecretNames('prod')).rejects.toThrow('Command failed');
    });
  });
});
