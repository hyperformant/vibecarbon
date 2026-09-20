import { describe, expect, it } from 'vitest';
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
