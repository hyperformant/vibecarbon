import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeConfigurationCheck, formatConfigurationLines } from '../../../src/status.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
// biome-ignore lint/suspicious/noControlCharactersInRegex: presence-of-ANSI check
const HAS_ANSI = /\x1b\[[0-9;]*m/;

// The `status` Configuration advisory — same checks Gate 1 (deploy.js)
// enforces before it will start provisioning, surfaced here as a passive
// read so an operator sees a malformed/missing credential before running
// `deploy` at all. Never renders a value, only the problem message
// `checkOperatorConfig` already produces (which itself never echoes one).
describe('formatConfigurationLines', () => {
  it('renders a single "ok" line with the checked-variable count when there are no problems', () => {
    const lines = formatConfigurationLines(
      [],
      ['HETZNER_API_TOKEN', 'ALLOWED_SSH_IPS', 'ACME_CA_SERVER', 'PULUMI_BACKEND_URL'],
    ).map(stripAnsi);
    expect(lines).toEqual(['Configuration ● ok  (4 variables checked)']);
  });

  // Styling matches its neighbour — the `Access:` advisory colours only the
  // meaningful inline piece (a command name), never the whole line/body.
  // Here that's the count, not the whole line.
  it('colors only the count, leaving the rest of the "ok" line plain', () => {
    const [line] = formatConfigurationLines([], ['HETZNER_API_TOKEN']);
    expect(line).toContain('\x1b[32m'); // green somewhere
    expect(line.startsWith('Configuration ● ok  ')).toBe(true); // plain, uncoloured prefix
  });

  it('singularizes "variable" when exactly one was checked', () => {
    const [line] = formatConfigurationLines([], ['HETZNER_API_TOKEN']).map(stripAnsi);
    expect(line).toBe('Configuration ● ok  (1 variable checked)');
  });

  it('renders a header plus one indented line per problem', () => {
    const lines = formatConfigurationLines(
      [
        'HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 20 characters',
        'ACME_CA_SERVER looks wrong: expected a URL, got 9 characters',
      ],
      ['HETZNER_API_TOKEN', 'ACME_CA_SERVER'],
    ).map(stripAnsi);
    expect(lines).toEqual([
      '▲ Configuration: 2 problems',
      '  - HETZNER_API_TOKEN looks wrong: expected 64 alphanumeric characters, got 20 characters',
      '  - ACME_CA_SERVER looks wrong: expected a URL, got 9 characters',
    ]);
  });

  it('colors only the count in the header, and leaves each problem detail line plain', () => {
    const lines = formatConfigurationLines(['X is not set', 'Y is not set'], ['X', 'Y']);
    expect(lines[0]).toContain('\x1b[33m'); // yellow somewhere in the header
    expect(lines[0].split(':')[0]).not.toMatch(HAS_ANSI); // "▲ Configuration" is plain
    for (const line of lines.slice(1)) expect(line).not.toMatch(HAS_ANSI); // "  - ..." lines are plain
  });

  it('singularizes "problem" when there is exactly one', () => {
    const [header] = formatConfigurationLines(['X looks wrong'], ['X']).map(stripAnsi);
    expect(header).toBe('▲ Configuration: 1 problem');
  });

  it('never echoes a variable value — only the problem strings passed in', () => {
    const secret = 'super-secret-token-value';
    const lines = formatConfigurationLines([`X is malformed`], ['X']).map(stripAnsi);
    expect(lines.join('\n')).not.toContain(secret);
  });
});

// computeConfigurationCheck — the derivation formatConfigurationLines
// renders. Tested directly (not just through the integration harness) via
// its injectable `{ env }`, using fake fixture values only.
describe('computeConfigurationCheck', () => {
  it('a fresh project (no environments, no config) checks only the always-known scopes and reports no problems', () => {
    const { problems, checked } = computeConfigurationCheck({}, {}, { env: {} });
    expect(problems).toEqual([]);
    // access/tls/state's optional keys — no provider is resolvable (no
    // environment, no projectConfig.provider, no deployMode anywhere) and
    // no Docker Hub creds are set in the injected empty env, so neither a
    // `provider:*` nor `registry` scope is added.
    expect(checked.length).toBeGreaterThan(0);
    expect(checked).not.toContain('HETZNER_API_TOKEN');
    expect(checked).not.toContain('DOCKER_HUB_USERNAME');
  });

  it('renders the fresh-project result as a plain "ok" line', () => {
    const { problems, checked } = computeConfigurationCheck({}, {}, { env: {} });
    const [line] = formatConfigurationLines(problems, checked).map(stripAnsi);
    expect(line).toMatch(/^Configuration ● ok {2}\(\d+ variables? checked\)$/);
  });

  // Important (review fix round): a variable checked by BOTH passes — the
  // project's default provider (base scopes, presence: false) AND a
  // deployed environment's cross-cloud DNS key (deployed scopes, presence:
  // true) — must be reported exactly once, not twice.
  //
  // Reachable case: `prod` carries neither `provider` nor `deployMode` (so
  // it contributes nothing to the deployed pass itself), which makes
  // `projectConfig.provider` ('hetzner') win as the project's configured
  // provider — that's a BASE (presence: false) scope. `staging` is a
  // deployed DigitalOcean environment with `dnsProvider: 'hetzner'`:
  // cross-cloud native DNS, so `operatorConfigForDns` falls through to the
  // ONE sibling key, HETZNER_API_TOKEN, checked WITH presence in the
  // deployed pass. Both passes now cover HETZNER_API_TOKEN — a malformed
  // value must not be counted twice.
  it('dedupes a problem checked by both the base and deployed-environment passes', () => {
    const { problems, checked } = computeConfigurationCheck(
      { provider: 'hetzner' },
      {
        prod: {},
        staging: { provider: 'digitalocean', dnsProvider: 'hetzner', deployMode: 'compose' },
      },
      { env: { HETZNER_API_TOKEN: 'a'.repeat(20) } },
    );
    const hetznerProblems = problems.filter((p) => p.startsWith('HETZNER_API_TOKEN'));
    expect(hetznerProblems).toHaveLength(1);
    expect(checked.filter((k) => k === 'HETZNER_API_TOKEN')).toHaveLength(1);
  });

  it('prefers the deployed (presence: true) pass’s message when only it would report the key', () => {
    // HETZNER_API_TOKEN is absent entirely here (not malformed) — the base
    // pass (presence: false) tolerates that silently, but the deployed
    // pass (presence: true, via the cross-cloud DNS key) does not: the
    // deployed pass's "is not set" problem must survive the merge, not be
    // swallowed because the base pass "already checked" that key.
    const { problems } = computeConfigurationCheck(
      { provider: 'hetzner' },
      {
        prod: {},
        staging: { provider: 'digitalocean', dnsProvider: 'hetzner', deployMode: 'compose' },
      },
      { env: {} },
    );
    expect(problems).toContain('HETZNER_API_TOKEN is not set');
  });
});

// A8 (spec §5, review 2026-09-19): the configure family (billing/oauth/smtp/
// analytics/landing) lives in the project's `.env`/`.env.local` FILES, never
// in process.env, so the two process.env passes above can never see a stale
// or malformed value `configure` wrote (or an operator hand-edited). This
// third pass reads the files — `.env.local` over `.env`, the same precedence
// the app itself sees — shape-only (`presence: false`: an unconfigured
// feature is not a problem). Enter-on-existing at the configure prompt
// deliberately keeps the stored value unvalidated (right for a prompt);
// `status` is where such a stale value surfaces. Fixture values only.
describe('computeConfigurationCheck — configure-family pass over .env/.env.local', () => {
  const dirs: string[] = [];
  function projectDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'vc-status-config-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports a stale publishable key stored as STRIPE_SECRET_KEY in .env — exactly one problem', () => {
    const cwd = projectDir({ '.env': 'STRIPE_SECRET_KEY=pk_test_x\nBILLING_PROVIDER=stripe\n' });
    const { problems, checked } = computeConfigurationCheck({}, {}, { env: {}, cwd });
    expect(problems).toEqual([
      'STRIPE_SECRET_KEY looks wrong: expected sk_live_…, sk_test_… or a restricted rk_… key, got 9 characters',
    ]);
    expect(checked).toContain('STRIPE_SECRET_KEY');
    expect(checked).toContain('BILLING_PROVIDER');
    expect(checked).toContain('SMTP_HOST');
    expect(checked).toContain('VITE_GITHUB_REPO_URL');
    // The pass is shape-only: every unset configure key is tolerated.
    expect(problems.some((p) => p.endsWith('is not set'))).toBe(false);
  });

  it('.env.local wins over .env (the app precedence) — a good local override hides a bad .env value', () => {
    const cwd = projectDir({
      '.env': 'STRIPE_SECRET_KEY=pk_test_x\n',
      '.env.local': 'STRIPE_SECRET_KEY=sk_test_localgood\n',
    });
    const { problems } = computeConfigurationCheck({}, {}, { env: {}, cwd });
    expect(problems).toEqual([]);
  });

  it('a project with no env files at all still renders ok (fresh clone, second worktree)', () => {
    const cwd = projectDir({});
    const { problems, checked } = computeConfigurationCheck({}, {}, { env: {}, cwd });
    expect(problems).toEqual([]);
    expect(checked).toContain('STRIPE_SECRET_KEY');
  });

  it('never echoes the stored value', () => {
    const cwd = projectDir({ '.env': 'SMTP_PORT=99999\nSMTP_ADMIN_EMAIL=not-an-email\n' });
    const { problems } = computeConfigurationCheck({}, {}, { env: {}, cwd });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).not.toContain('99999');
    expect(problems.join('\n')).not.toContain('not-an-email');
  });

  it('a normalizable paste (quotes, whitespace) stored in the file is not a problem — the reader normalizes on every read', () => {
    // dotenv single-quoting keeps the inner double quotes + padding literal.
    const cwd = projectDir({ '.env': 'STRIPE_SECRET_KEY=\'  "sk_test_abc"  \'\n' });
    const { problems } = computeConfigurationCheck({}, {}, { env: {}, cwd });
    expect(problems).toEqual([]);
  });
});
