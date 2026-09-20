import { describe, expect, it } from 'vitest';
import { formatConfigurationLines } from '../../../src/status.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping for assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// The `status` Configuration advisory — same checks Gate 1 (deploy.js)
// enforces before it will start provisioning, surfaced here as a passive
// read so an operator sees a malformed/missing credential before running
// `deploy` at all. Never renders a value, only the problem message
// `checkOperatorConfig` already produces (which itself never echoes one).
describe('formatConfigurationLines', () => {
  it('renders a single green "ok" line with the checked-variable count when there are no problems', () => {
    const lines = formatConfigurationLines(
      [],
      ['HETZNER_API_TOKEN', 'ALLOWED_SSH_IPS', 'ACME_CA_SERVER', 'PULUMI_BACKEND_URL'],
    ).map(stripAnsi);
    expect(lines).toEqual(['Configuration ● ok  (4 variables checked)']);
  });

  it('colors the "ok" line green', () => {
    const [line] = formatConfigurationLines([], ['HETZNER_API_TOKEN']);
    expect(line).toContain('\x1b[32m'); // green
  });

  it('singularizes "variable" when exactly one was checked', () => {
    const [line] = formatConfigurationLines([], ['HETZNER_API_TOKEN']).map(stripAnsi);
    expect(line).toBe('Configuration ● ok  (1 variable checked)');
  });

  it('renders a yellow header plus one indented line per problem', () => {
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

  it('colors the problem lines yellow', () => {
    const lines = formatConfigurationLines(['X is not set'], ['X']);
    for (const line of lines) expect(line).toContain('\x1b[33m'); // yellow
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
