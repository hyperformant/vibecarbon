/**
 * The API-token lines name where the token actually came from.
 *
 * Every provider said "from HETZNER_API_TOKEN environment variable" (or
 * "... environment variable is set but invalid") whether the token came
 * from an export in the shell or from the project's .env.local, which sends
 * an operator fixing a stale token to the wrong place. Same source helper as
 * the S3 keys (describeCredentialSource).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sourceMock = vi.hoisted(() => ({
  value: {
    source: 'env-local',
    label: "your project's .env.local",
    where: "your project's .env.local",
  },
}));
const clackMock = vi.hoisted(() => ({
  text: vi.fn(async () => Symbol.for('cancel')),
  password: vi.fn(async () => Symbol.for('cancel')),
  confirm: vi.fn(),
  select: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/project.js', () => ({
  setEnvVar: vi.fn(),
  describeCredentialSource: () => sourceMock.value,
}));
vi.mock('../../../src/lib/cli/tty-guard.js', () => ({ assertInteractiveStdin: vi.fn() }));

const CASES = [
  { provider: 'hetzner', env: { HETZNER_API_TOKEN: 'a'.repeat(64) } },
  { provider: 'digitalocean', env: { DIGITALOCEAN_API_TOKEN: 'dop_v1_tokentokentoken' } },
  { provider: 'linode', env: { LINODE_API_TOKEN: 'b'.repeat(64) } },
  { provider: 'vultr', env: { VULTR_API_TOKEN: 'VULTRTOKENVULTRTOKEN' } },
  { provider: 'cloudflare', env: { CLOUDFLARE_API_TOKEN: 'cloudflare-token-sample' } },
  {
    provider: 'scaleway',
    env: {
      SCALEWAY_SECRET_KEY: '11111111-2222-4333-8444-555555555555',
      SCALEWAY_ACCESS_KEY: 'SCWABCDEFGHIJ0123456',
      SCALEWAY_DEFAULT_PROJECT_ID: '11111111-2222-4333-8444-666666666666',
    },
  },
] as const;

const all = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => String(c[0])).join('\n');

describe.each(CASES)('$provider getApiToken', ({ provider, env }) => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('names the real source of a working token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, result: { status: 'active' } }), {
            status: 200,
          }),
      ),
    );
    const mod = await import(`../../../src/lib/${provider}-guided-setup.js`);
    await mod.getApiToken('proj', { save: false });
    const info = all(clackMock.log.info);
    expect(info).toContain("from your project's .env.local");
    expect(info).not.toMatch(/environment variables?\b/);
  });

  it('names the real source of a rejected token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ success: false, errors: [] }), { status: 401 }),
      ),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const mod = await import(`../../../src/lib/${provider}-guided-setup.js`);
    await mod.getApiToken('proj', { save: false }).catch(() => {});
    exit.mockRestore();
    const warn = all(clackMock.log.warn);
    expect(warn).toMatch(/from your project's \.env\.local is set but invalid/);
    expect(warn).not.toContain('environment variable is set but invalid');
  });
});
