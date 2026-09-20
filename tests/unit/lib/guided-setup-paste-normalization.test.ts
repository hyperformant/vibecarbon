/**
 * M11 (whole-branch review 2026-09-19): the provider guided-setup prompts are
 * the FIRST-TIME-USER path — a fresh operator pastes a token out of a vendor
 * console straight into `p.password()`. Those prompts used to accept the raw
 * paste (`v.length < 10` was the only check) and write it, quotes/newline
 * and all, to `process.env` and — on "save" — to `.env.local`. Every LATER
 * read goes through `readOperatorVar` and is normalized, but the value the
 * prompt itself verified against the live API and handed to the deploy was
 * the raw one.
 *
 * Each guided setup now wraps the accepted paste in
 * `normalizeOperatorValue(raw, registryEntry(KEY)).value` before verifying,
 * exporting or saving it. One shared test file rather than six near-identical
 * additions: the six modules share the same shape (password prompt -> live
 * verify -> `process.env.X = token` -> optional save), so a table drives them.
 *
 * Fixture values only — nothing here is a real credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  password: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn(), step: vi.fn() },
}));
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/cli/tty-guard.js', () => ({ assertInteractiveStdin: vi.fn() }));

const setEnvVarMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/project.js', () => ({ setEnvVar: setEnvVarMock }));

// Cloudflare verifies through cloudflare-dns.js's verifyToken (fetchWithRetry
// underneath); the others call fetch directly. Both are stubbed to "valid".
const verifyTokenMock = vi.hoisted(() => vi.fn(async () => ({ valid: true })));
vi.mock('../../../src/lib/cloudflare-dns.js', () => ({ verifyToken: verifyTokenMock }));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

type Case = {
  module: string;
  key: string;
  clean: string;
  /** Where the module puts the token on its live-verify request. */
  headerOf?: (init: RequestInit) => string | undefined;
  /** Extra prompts the module runs after the token (Scaleway's companions). */
  companions?: Array<{ key: string; clean: string }>;
};

const CASES: Case[] = [
  {
    module: 'hetzner',
    key: 'HETZNER_API_TOKEN',
    clean: 'a'.repeat(64),
    headerOf: (init) => (init.headers as Record<string, string>).Authorization,
  },
  {
    module: 'digitalocean',
    key: 'DIGITALOCEAN_API_TOKEN',
    clean: `dop_v1_${'b'.repeat(64)}`,
    headerOf: (init) => (init.headers as Record<string, string>).Authorization,
  },
  {
    module: 'linode',
    key: 'LINODE_API_TOKEN',
    clean: 'c'.repeat(64),
    headerOf: (init) => (init.headers as Record<string, string>).Authorization,
  },
  {
    module: 'vultr',
    key: 'VULTR_API_TOKEN',
    clean: 'D'.repeat(36),
    headerOf: (init) => (init.headers as Record<string, string>).Authorization,
  },
  {
    module: 'scaleway',
    key: 'SCALEWAY_SECRET_KEY',
    clean: '12345678-1234-4123-8123-123456789012',
    headerOf: (init) => (init.headers as Record<string, string>)['X-Auth-Token'],
    companions: [
      { key: 'SCALEWAY_ACCESS_KEY', clean: 'SCWABCDEFGHIJKLMNOPQ' },
      { key: 'SCALEWAY_DEFAULT_PROJECT_ID', clean: '87654321-4321-4321-8321-210987654321' },
    ],
  },
  { module: 'cloudflare', key: 'CLOUDFLARE_API_TOKEN', clean: 'e'.repeat(40) },
];

/** The classic vendor-console paste: trailing newline AND surrounding quotes. */
const wrap = (clean: string) => `"${clean}"\n`;

const ALL_KEYS = CASES.flatMap((c) => [c.key, ...(c.companions ?? []).map((x) => x.key)]);

describe('guided setups normalize an accepted paste before verifying, exporting or saving it', () => {
  const ambient: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ALL_KEYS) {
      ambient[key] = process.env[key];
      delete process.env[key];
    }
    clackMock.password.mockReset();
    clackMock.text.mockReset();
    clackMock.confirm.mockReset();
    clackMock.confirm.mockResolvedValue(false);
    setEnvVarMock.mockReset();
    verifyTokenMock.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  });

  afterEach(() => {
    for (const key of ALL_KEYS) {
      if (ambient[key] === undefined) delete process.env[key];
      else process.env[key] = ambient[key];
    }
  });

  for (const tc of CASES) {
    it(`${tc.module}: getApiToken exports and returns the normalized ${tc.key}, and verifies the clean value`, async () => {
      clackMock.password.mockResolvedValue(wrap(tc.clean));
      if (tc.companions) {
        for (const companion of tc.companions) {
          clackMock.text.mockResolvedValueOnce(wrap(companion.clean));
        }
      }
      vi.resetModules();
      const mod = await import(`../../../src/lib/${tc.module}-guided-setup.js`);

      const result = await mod.getApiToken('my-project', { force: true, save: false });

      expect(result).toBe(tc.clean);
      expect(process.env[tc.key]).toBe(tc.clean);
      for (const companion of tc.companions ?? []) {
        expect(process.env[companion.key]).toBe(companion.clean);
      }

      // The live verification saw the clean value, not the paste.
      if (tc.headerOf) {
        const verifyCall = fetchMock.mock.calls.at(-1);
        expect(verifyCall, 'expected a live-verify fetch').toBeDefined();
        const header = tc.headerOf(verifyCall?.[1] as RequestInit) ?? '';
        expect(header).toContain(tc.clean);
        expect(header).not.toContain('"');
        expect(header).not.toContain('\n');
      } else {
        expect(verifyTokenMock).toHaveBeenCalledWith(tc.clean);
      }
    });
  }

  it('hetzner: the save path persists the normalized token, never the raw paste', async () => {
    const clean = 'f'.repeat(64);
    clackMock.password.mockResolvedValue(wrap(clean));
    clackMock.confirm.mockResolvedValue(true);
    vi.resetModules();
    const { getApiToken } = await import('../../../src/lib/hetzner-guided-setup.js');

    await getApiToken('my-project', { force: true });

    expect(setEnvVarMock).toHaveBeenCalledWith('HETZNER_API_TOKEN', clean, expect.any(String), {
      localOnly: true,
    });
  });

  it('hetzner: getS3Credentials normalizes both keys (text + password prompts)', async () => {
    clackMock.text.mockResolvedValue(wrap('AK-fresh-1234567'));
    clackMock.password.mockResolvedValue(wrap('SK-fresh-1234567'));
    vi.resetModules();
    const { getS3Credentials } = await import('../../../src/lib/hetzner-guided-setup.js');

    const result = await getS3Credentials('my-project', { force: true, save: false });

    expect(result).toEqual({ accessKey: 'AK-fresh-1234567', secretKey: 'SK-fresh-1234567' });
    expect(process.env.HETZNER_ACCESS_KEY).toBe('AK-fresh-1234567');
    expect(process.env.HETZNER_SECRET_KEY).toBe('SK-fresh-1234567');
  });

  it('hetzner: a quote-wrapped 64-char token passes the 64-length check (it is measured after normalization)', async () => {
    const clean = 'g'.repeat(64);
    clackMock.password.mockResolvedValue(clean);
    vi.resetModules();
    const { getApiToken } = await import('../../../src/lib/hetzner-guided-setup.js');
    await getApiToken('my-project', { force: true, save: false });

    const { validate } = clackMock.password.mock.calls[0][0];
    expect(validate(`"${clean}"`)).toBeUndefined();
    expect(validate(`${clean}\n`)).toBeUndefined();
    expect(validate('short-token')).toMatch(/64 characters/);
  });
});
