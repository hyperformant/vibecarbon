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
 *   3. a source census: every `validate: (<param>) =>` in
 *      `src/lib/*-guided-setup.js` and in `src/lib/configure-providers.js`
 *      (the token-only fallback prompt for a compute provider with no guided
 *      module) hands ITS OWN parameter to the helper, except the listed
 *      prompts whose value never reaches an env file; create.js's
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

  type Prompt = { message: string; param: string; body: string };
  /**
   * Each text/password prompt: `p.text({ message: '…', … validate: (v) => { … },`.
   * The span between message and validate may not cross another prompt opener,
   * so a prompt WITHOUT a validate yields no match instead of borrowing the next
   * prompt's callback (and silently dropping that prompt). The validate
   * parameter is CAPTURED, not assumed: a prompt written `validate: (value) =>`
   * is judged by `value`, so `dotenvPromptProblem('K', v)` with a stale `v` (or
   * none at all) cannot pass on the parameter's name.
   */
  function promptsIn(src: string): Prompt[] {
    return [
      ...src.matchAll(
        /p\.(?:text|password)\(\{\s*message: (?:'([^']*)'|`([^`]*)`),(?:(?!p\.(?:text|password)\()[\s\S])*?validate: (?:async )?\((\w+)(?::\s*\w+)?\) => \{([\s\S]*?)\n\s*\},/g,
      ),
    ].map(([, quoted, template, param, body]) => ({ message: quoted ?? template, param, body }));
  }
  /** Every text/password prompt opener in a file, with or without a validate. */
  const promptOpenerCount = (src: string) => (src.match(/p\.(?:text|password)\(\{/g) ?? []).length;
  /** Every validate callback in a file, whatever its parameter is called. */
  const validateCount = (src: string) =>
    (src.match(/validate: (?:async )?\(\w+(?::\s*\w+)?\) =>/g) ?? []).length;
  const callsHelper = ({ param, body }: Prompt) =>
    new RegExp(String.raw`dotenvPromptProblem\((?:'[A-Z_]+'|Provider\.TOKEN_ENV), ${param}\)`).test(
      body,
    );

  it('judges a prompt by its own validate parameter, not by the name `v`', () => {
    const snippet = (param: string, arg: string) =>
      `const t = await p.password({\n  message: 'Token',\n  validate: (${param}) => {\n    const bad = dotenvPromptProblem('X_TOKEN', ${arg});\n    if (bad) return bad;\n  },\n});`;
    expect(promptsIn(snippet('v', 'v')).map(callsHelper)).toEqual([true]);
    expect(promptsIn(snippet('value', 'value')).map(callsHelper)).toEqual([true]);
    // The stale-name case Reviewer Note B describes: `(value) =>` whose body
    // still hands `v` to the helper (an outer variable, not the input).
    expect(promptsIn(snippet('value', 'v')).map(callsHelper)).toEqual([false]);
    expect(promptsIn(snippet('value', 'value')).map((x) => x.param)).toEqual(['value']);
    expect(validateCount(snippet('value', 'value'))).toBe(1);
  });

  it('a prompt with no validate is counted as a prompt but never paired with the next one', () => {
    const noValidate =
      "const d = await p.text({\n  message: 'A domain',\n  placeholder: 'x',\n});\n";
    const withValidate =
      "const t = await p.password({\n  message: 'B token',\n  validate: (v) => {\n    return dotenvPromptProblem('X_TOKEN', v);\n  },\n});\n";
    const src = noValidate + withValidate;
    expect(promptsIn(src).map((x) => x.message)).toEqual(['B token']);
    expect(promptOpenerCount(src)).toBe(2);
    expect(validateCount(src)).toBe(1);
    // The census's drift check compares captured prompts to OPENERS, so this
    // file shape fails it (1 !== 2) instead of passing with A silently dropped.
    expect(promptsIn(src).length).not.toBe(promptOpenerCount(src));
  });

  for (const file of files) {
    it(file, () => {
      const src = readFileSync(join(ROOT, 'src/lib', file), 'utf-8');
      const prompts = promptsIn(src);
      // Every text/password prompt in these modules carries a validate, and
      // every validate belongs to one of them: a prompt that lost its validate
      // shows up as an opener without a capture.
      expect(prompts.length, `${file}: a prompt without a validate, or the regex drifted`).toBe(
        promptOpenerCount(src),
      );
      expect(prompts.length, `${file}: prompt regex drifted`).toBe(validateCount(src));
      expect(prompts.length).toBeGreaterThan(0);
      const missing = prompts
        .filter(({ message }) => !NOT_AN_ENV_VALUE.has(message))
        .filter((prompt) => !callsHelper(prompt))
        .map(({ message }) => message);
      expect(missing, `${file}: prompts whose validate lacks dotenvPromptProblem`).toEqual([]);
    });
  }

  it("create.js's admin-password prompt checks ADMIN_PASSWORD", () => {
    const src = readFileSync(join(ROOT, 'src/create.js'), 'utf-8');
    expect(src).toMatch(/dotenvValueProblem\('ADMIN_PASSWORD', value\)/);
  });
});
