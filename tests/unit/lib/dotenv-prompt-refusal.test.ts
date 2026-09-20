/**
 * Prompt-time refusal (2026-09-20 dotenv dialect spec): every clack prompt
 * whose accepted value ends in `setEnvVar` (or in create's generateEnvLocal)
 * rejects, INSIDE its `validate` callback, a value the portable .env grammar
 * cannot hold — so the operator sees the reason and re-enters, instead of
 * `setEnvVar` throwing after every other prompt in the flow has run. The
 * message names the key and the reason, never the value.
 *
 * Three layers, one file:
 *   1. `dotenvPromptProblem` (operator-env.js), the helper the guided setups use;
 *   2. the live `validate` callbacks — configure's promptText/promptSecret and
 *      the six provider guided setups' token prompts, driven through a mocked
 *      @clack/prompts exactly like guided-setup-paste-normalization.test.ts;
 *   3. a source census: every `validate: (v) =>` in `src/lib/*-guided-setup.js`
 *      and in `src/lib/configure-providers.js` (the token-only fallback prompt
 *      for a compute provider with no guided module) calls the helper, except
 *      the listed prompts whose value never reaches an env file; create.js's
 *      admin-password prompt checks ADMIN_PASSWORD.
 *
 * Fixture values only — nothing here is a real credential.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registryEntry } from '../../../src/lib/config-registry.js';
import { dotenvPromptProblem } from '../../../src/lib/operator-env.js';

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
vi.mock('../../../src/lib/project.js', () => ({
  setEnvVar: vi.fn(),
  loadEnvVariables: vi.fn(() => ({})),
  buildGitAddArgv: vi.fn(() => []),
}));
const verifyTokenMock = vi.hoisted(() => vi.fn(async () => ({ valid: true })));
vi.mock('../../../src/lib/cloudflare-dns.js', () => ({ verifyToken: verifyTokenMock }));
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

const ROOT = join(import.meta.dirname, '../../..');

/** `'` mixed with `"`: no form Node, Compose and Vite all read the same way. */
const MIXED = `mix ' and "`;
/** Long enough for every `v.length < 10` / 64-char pre-check in the prompts. */
const MIXED_64 = MIXED.padEnd(64, 'x');

function expectRefusal(message: unknown, key: string) {
  expect(typeof message).toBe('string');
  expect(message).toMatch(new RegExp(`^${key} it mixes a single quote with "`));
  expect(message).not.toContain('mix ');
  expect(message).not.toContain('xxx');
}

describe('dotenvPromptProblem', () => {
  it('returns the key-prefixed reason for an unrepresentable value, never the value', () => {
    expectRefusal(dotenvPromptProblem('HETZNER_API_TOKEN', MIXED), 'HETZNER_API_TOKEN');
  });

  it('returns undefined for a value the grammar can hold', () => {
    expect(dotenvPromptProblem('HETZNER_API_TOKEN', 'a'.repeat(64))).toBeUndefined();
    expect(dotenvPromptProblem('SMTP_SENDER_NAME', "O'Brien & Co")).toBeUndefined();
    expect(dotenvPromptProblem('SMTP_PASS', 'say "hi" for $5')).toBeUndefined();
  });

  it('judges the NORMALIZED paste, so console quote-wrapping alone is not a refusal', () => {
    expect(dotenvPromptProblem('HETZNER_API_TOKEN', `"${'a'.repeat(64)}"\n`)).toBeUndefined();
  });

  it('refuses "$" in a VITE_* value and a control character anywhere', () => {
    expect(dotenvPromptProblem('VITE_PLAUSIBLE_DOMAIN', 'a$b')).toMatch(
      /^VITE_PLAUSIBLE_DOMAIN it contains "\$"/,
    );
    expect(dotenvPromptProblem('SMTP_PASS', 'tab\there')).toMatch(
      /^SMTP_PASS it contains a control character/,
    );
  });

  it('works for a key with no registry entry (raw value judged as-is)', () => {
    expectRefusal(dotenvPromptProblem('NOT_IN_REGISTRY', MIXED), 'NOT_IN_REGISTRY');
    expect(dotenvPromptProblem('NOT_IN_REGISTRY', 'plain')).toBeUndefined();
  });
});

describe('configure promptText/promptSecret refuse at the prompt', () => {
  beforeEach(() => {
    clackMock.text.mockReset();
    clackMock.password.mockReset();
  });

  it('promptText: the validate callback returns the reason before the shape check', async () => {
    clackMock.text.mockResolvedValue('Acme');
    const { promptText } = await import('../../../src/configure.js');
    await promptText('Sender display name', undefined, {
      entry: registryEntry('SMTP_SENDER_NAME'),
    });
    const { validate } = clackMock.text.mock.calls[0][0];
    expectRefusal(validate(MIXED), 'SMTP_SENDER_NAME');
    expect(validate('Acme Mail')).toBeUndefined();
  });

  it('promptSecret: same, for a masked prompt', async () => {
    clackMock.password.mockResolvedValue('p'.repeat(20));
    const { promptSecret } = await import('../../../src/configure.js');
    await promptSecret('SMTP password', undefined, { entry: registryEntry('SMTP_PASS') });
    const { validate } = clackMock.password.mock.calls[0][0];
    expectRefusal(validate(MIXED_64), 'SMTP_PASS');
    expect(validate('p'.repeat(20))).toBeUndefined();
  });
});

type Case = { module: string; key: string; clean: string; companions?: string[] };
const CASES: Case[] = [
  { module: 'hetzner', key: 'HETZNER_API_TOKEN', clean: 'a'.repeat(64) },
  { module: 'digitalocean', key: 'DIGITALOCEAN_API_TOKEN', clean: `dop_v1_${'b'.repeat(64)}` },
  { module: 'linode', key: 'LINODE_API_TOKEN', clean: 'c'.repeat(64) },
  { module: 'vultr', key: 'VULTR_API_TOKEN', clean: 'D'.repeat(36) },
  {
    module: 'scaleway',
    key: 'SCALEWAY_SECRET_KEY',
    clean: '12345678-1234-4123-8123-123456789012',
    companions: ['SCWABCDEFGHIJKLMNOPQ', '87654321-4321-4321-8321-210987654321'],
  },
  { module: 'cloudflare', key: 'CLOUDFLARE_API_TOKEN', clean: 'e'.repeat(40) },
];
const ALL_KEYS = CASES.map((c) => c.key).concat([
  'SCALEWAY_ACCESS_KEY',
  'SCALEWAY_DEFAULT_PROJECT_ID',
]);

describe('guided-setup token prompts refuse at the prompt', () => {
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
    it(`${tc.module}: the ${tc.key} password prompt's validate names the key, not the value`, async () => {
      clackMock.password.mockResolvedValue(tc.clean);
      for (const companion of tc.companions ?? []) clackMock.text.mockResolvedValueOnce(companion);
      vi.resetModules();
      const mod = await import(`../../../src/lib/${tc.module}-guided-setup.js`);
      await mod.getApiToken('my-project', { force: true, save: false });

      const { validate } = clackMock.password.mock.calls[0][0];
      expectRefusal(validate(MIXED_64), tc.key);
      expect(validate(tc.clean)).toBeUndefined();
    });
  }
});

describe('census: every provider prompt that reaches an env file calls dotenvPromptProblem', () => {
  // Prompts whose value is never written to .env/.env.local, by exact message.
  const NOT_AN_ENV_VALUE = new Set([
    // scaleway onboardDomain: the domain goes to the Scaleway API, not to a file.
    'Domain to add to Scaleway (the registrable name, not a subdomain)',
  ]);

  // configure-providers.js holds genericGetApiToken, the prompt a compute
  // provider without a COMPUTE_GUIDED_MODULES entry falls back to; its value
  // reaches setEnvVar through configure.js exactly like a guided token.
  const files = readdirSync(join(ROOT, 'src/lib'))
    .filter((f) => f.endsWith('-guided-setup.js'))
    .concat(['configure-providers.js']);

  it('finds the six provider modules and the generic fallback', () => {
    expect(files.sort()).toEqual([
      'cloudflare-guided-setup.js',
      'configure-providers.js',
      'digitalocean-guided-setup.js',
      'hetzner-guided-setup.js',
      'linode-guided-setup.js',
      'scaleway-guided-setup.js',
      'vultr-guided-setup.js',
    ]);
  });

  for (const file of files) {
    it(file, () => {
      const src = readFileSync(join(ROOT, 'src/lib', file), 'utf-8');
      // Each text/password prompt: `p.text({ message: '…', … validate: (v) => { … },`
      const prompts = [
        ...src.matchAll(
          /p\.(?:text|password)\(\{\s*message: (?:'([^']*)'|`([^`]*)`),[\s\S]*?validate: \(v\) => \{([\s\S]*?)\n\s*\},/g,
        ),
      ];
      // Every validate callback in these modules belongs to a text/password prompt.
      const validates = src.match(/validate: \(v\) =>/g) ?? [];
      expect(prompts.length, `${file}: prompt regex drifted`).toBe(validates.length);
      expect(prompts.length).toBeGreaterThan(0);
      const missing = prompts
        .map(([, quoted, template, body]) => ({ message: quoted ?? template, body }))
        .filter(({ message }) => !NOT_AN_ENV_VALUE.has(message))
        .filter(
          ({ body }) => !/dotenvPromptProblem\((?:'[A-Z_]+'|Provider\.TOKEN_ENV), v\)/.test(body),
        )
        .map(({ message }) => message);
      expect(missing, `${file}: prompts whose validate lacks dotenvPromptProblem`).toEqual([]);
    });
  }

  it("create.js's admin-password prompt checks ADMIN_PASSWORD", () => {
    const src = readFileSync(join(ROOT, 'src/create.js'), 'utf-8');
    expect(src).toMatch(/dotenvValueProblem\('ADMIN_PASSWORD', value\)/);
  });
});
