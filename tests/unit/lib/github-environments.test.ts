/**
 * Unit tests for src/lib/github-environments.js (Phase 4.3b.A of the
 * GitOps refactor). Mocks `runCommandAsync` so no real `gh` calls are
 * made; verifies the correct argv is passed and that secret values flow
 * through stdin (not --body on argv) for secret-set operations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  describe('seedOrgSecrets', () => {
    it('only sets non-empty secrets and feeds values via stdin (never --body)', async () => {
      const { seedOrgSecrets } = await freshImport();
      const applied = await seedOrgSecrets({
        hetznerApiToken: 'hcloud-abc',
        dnsTokens: { CLOUDFLARE_API_TOKEN: 'cf-abc', DESEC_TOKEN: '' /* empty → skipped */ },
      });
      expect(applied).toEqual(['HETZNER_API_TOKEN', 'CLOUDFLARE_API_TOKEN']);

      const secretSetCalls = runCommandAsyncMock.mock.calls.filter(
        (c) => c[0][0] === 'gh' && c[0][1] === 'secret' && c[0][2] === 'set',
      );
      expect(secretSetCalls).toHaveLength(2);

      // Every secret-set call: value on stdin (options.input), never on argv.
      for (const [argv, opts] of secretSetCalls) {
        expect(argv).not.toContain('--body');
        expect(argv).not.toContain('--body-file');
        // Env-level should NOT appear (org-level secrets).
        expect(argv).not.toContain('--env');
        // Value flows via stdin.
        expect(typeof opts?.input).toBe('string');
        expect(opts.input.length).toBeGreaterThan(0);
      }
    });

    it('never seeds a repo-level object storage pair: the app gets its own per environment', async () => {
      const { seedOrgSecrets } = await freshImport();
      // A stray pair from an older caller is ignored, never uploaded.
      const applied = await seedOrgSecrets({
        s3AccessKey: 'SENTINEL_INFRA_AK',
        s3SecretKey: 'SENTINEL_INFRA_SK',
      } as Record<string, string>);
      expect(applied).toEqual([]);
      const uploaded = runCommandAsyncMock.mock.calls.map((c) => c[1]?.input).filter(Boolean);
      expect(uploaded).not.toContain('SENTINEL_INFRA_AK');
    });

    it('defaults to an empty object and applies nothing when called with no args', async () => {
      const { seedOrgSecrets } = await freshImport();
      const applied = await seedOrgSecrets();
      expect(applied).toEqual([]);
    });
  });

  describe('seedEnvironmentSecrets', () => {
    it('ensures the env exists then sets secrets + vars at env scope', async () => {
      const { seedEnvironmentSecrets } = await freshImport();
      const result = await seedEnvironmentSecrets(
        'dev',
        { DB_PASSWORD: 'pw', JWT_SECRET: '' /* skipped */ },
        { SITE_URL: 'https://dev.example.com', DNS_PROVIDER: '' /* skipped */ },
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
        { silent: true, timeout: 5000 },
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
