/**
 * Unit tests for src/lib/github-environments.js (Phase 4.3b.A of the
 * GitOps refactor). Mocks `runCommandAsync` so no real `gh` calls are
 * made; verifies the correct argv is passed and that secret values flow
 * through stdin (not --body on argv) for secret-set operations.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

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
    // Default: `gh repo view` returns "acme/vibecarbon", everything else
    // returns empty string (non-null).
    runCommandAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'gh' && argv[1] === 'repo' && argv[2] === 'view') {
        return 'acme/vibecarbon\n';
      }
      return '';
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('ensureEnvironment', () => {
    it('issues a PUT against the repo environments API', async () => {
      const { ensureEnvironment } = await freshImport();
      await ensureEnvironment('prod');
      const calls = runCommandAsyncMock.mock.calls;
      // First call: gh repo view. Second: gh api PUT.
      const apiCall = calls.find((c) => c[0][1] === 'api');
      expect(apiCall?.[0]).toEqual([
        'gh',
        'api',
        'repos/acme/vibecarbon/environments/prod',
        '-X',
        'PUT',
      ]);
    });
  });

  describe('repo-level secrets', () => {
    it('there is no repo-level secret seeder: every secret is per environment', async () => {
      // The last one wrote the Hetzner Cloud API token for deploy.yml's
      // kube-system/hcloud step, which is gone with it
      // (tests/unit/deploy/gitops-provider-token.test.ts).
      const mod = await freshImport();
      expect(Object.keys(mod)).not.toContain('seedOrgSecrets');
      // `gh secret set` without --env is repo-level: every call names one.
      const src = readFileSync(join(process.cwd(), 'src/lib/github-environments.js'), 'utf-8');
      const calls = [...src.matchAll(/(?<!function )setSecretFromBodyFile\(([^)]*)\)/g)].map(
        ([, args]) => args.split(',').map((a) => a.trim()),
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) expect(args[2], args.join(', ')).toBe('envName');
    });
  });

  describe('seedEnvironmentSecrets', () => {
    it('ensures the env exists then sets secrets + vars at env scope', async () => {
      const { seedEnvironmentSecrets } = await freshImport();
      const result = await seedEnvironmentSecrets(
        'dev',
        { DB_PASSWORD: 'pw', JWT_SECRET: '' /* skipped */ },
        { SITE_URL: 'https://dev.example.com', TLS_SNAPSHOT_S3_PREFIX: '' /* skipped */ },
      );
      expect(result.secrets).toEqual(['DB_PASSWORD']);
      expect(result.vars).toEqual(['SITE_URL']);

      const calls = runCommandAsyncMock.mock.calls;
      const envArgs = calls.map((c) => c[0]);
      // Env creation PUT happened.
      expect(envArgs.some((a) => a[1] === 'api' && a[2]?.endsWith('/environments/dev'))).toBe(true);
      // DB_PASSWORD set with --env dev, value on stdin (not argv).
      const dbEntry = calls.find(
        (c) =>
          c[0][0] === 'gh' &&
          c[0][1] === 'secret' &&
          c[0][2] === 'set' &&
          c[0][3] === 'DB_PASSWORD',
      );
      expect(dbEntry).toBeDefined();
      expect(dbEntry?.[0]).toContain('--env');
      expect(dbEntry?.[0]).toContain('dev');
      expect(dbEntry?.[0]).not.toContain('--body');
      expect(dbEntry?.[0]).not.toContain('--body-file');
      expect(dbEntry?.[1]?.input).toBe('pw');
      // SITE_URL variable set with --env dev (vars use --body, argv is fine).
      const siteCall = envArgs.find(
        (a) => a[0] === 'gh' && a[1] === 'variable' && a[2] === 'set' && a[3] === 'SITE_URL',
      );
      expect(siteCall).toContain('--env');
      expect(siteCall).toContain('dev');
      expect(siteCall).toContain('--body');
      expect(siteCall).toContain('https://dev.example.com');
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

  describe('seedEnvironmentSecrets timeout', () => {
    it('bounds every gh call when given a timeout', async () => {
      const { seedEnvironmentSecrets } = await freshImport();
      await seedEnvironmentSecrets(
        'prod',
        { DB_PASSWORD: 'pw' },
        { SITE_URL: 'https://x' },
        {
          timeout: 7000,
        },
      );
      for (const [, opts] of runCommandAsyncMock.mock.calls) {
        expect(opts.timeout).toBe(7000);
      }
      expect(runCommandAsyncMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('uploadKubeconfig', () => {
    it('uploads the kubeconfig with response compression off, leaving the local file as it is', async () => {
      // An older CLI's kubeconfig has no disable-compression. The GitOps
      // runner gets the field anyway (the workflow sets it too), and the
      // local file is never rewritten: configure cicd only reads it.
      const old = [
        'apiVersion: v1',
        'clusters:',
        '- cluster:',
        '    server: https://203.0.113.4:6443',
        '  name: default',
        'kind: Config',
        '',
      ].join('\n');
      const dir = createTempDir('vc-upload-kc-');
      const path = join(dir, 'kubeconfig-prod');
      writeFileSync(path, old);
      const { uploadKubeconfig } = await freshImport();

      await uploadKubeconfig('prod', path);

      const call = runCommandAsyncMock.mock.calls.find(
        ([argv]) => argv[1] === 'secret' && argv[3] === 'KUBECONFIG_B64',
      );
      expect(call?.[0]).toEqual(['gh', 'secret', 'set', 'KUBECONFIG_B64', '--env', 'prod']);
      const uploaded = Buffer.from(call?.[1].input, 'base64').toString('utf-8');
      expect(uploaded).toContain(
        '    disable-compression: true\n    server: https://203.0.113.4:6443',
      );
      expect(readFileSync(path, 'utf-8')).toBe(old);
    });
  });

  describe('triggerDeployWorkflow', () => {
    it('fires deploy.yml on main with -F environment=<env>', async () => {
      const { triggerDeployWorkflow } = await freshImport();
      await triggerDeployWorkflow('prod');
      const argv = runCommandAsyncMock.mock.calls
        .map((c) => c[0])
        .find((a) => a[0] === 'gh' && a[1] === 'workflow');
      expect(argv).toEqual([
        'gh',
        'workflow',
        'run',
        'deploy.yml',
        '--ref',
        'main',
        '-F',
        'environment=prod',
      ]);
    });
  });
});
