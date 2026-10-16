/**
 * A bare `vibecarbon deploy` used to go straight to "prod" without a pause.
 * promptEnvironmentName pauses on an editable "prod" default so a first
 * deploy always offers the choice, and stays silent for -y, non-TTY runs and
 * an env named on the command line.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    step: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);

import { promptEnvironmentName, shouldReaskManualDns } from '../../../src/lib/deploy/prompts.js';

describe('promptEnvironmentName', () => {
  afterEach(() => clackMock.text.mockReset());

  it('pauses on an editable prod default when no env was named', async () => {
    clackMock.text.mockResolvedValue('prod');
    expect(await promptEnvironmentName({ env: null, yes: false }, { isTTY: true })).toBe('prod');
    expect(clackMock.text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: 'prod', defaultValue: 'prod' }),
    );
  });

  it('returns a typed name, normalized', async () => {
    clackMock.text.mockResolvedValue('  Staging ');
    expect(await promptEnvironmentName({ env: null, yes: false }, { isTTY: true })).toBe('staging');
  });

  it('maps "production" to prod like the positional arg does', async () => {
    clackMock.text.mockResolvedValue('production');
    expect(await promptEnvironmentName({ env: null, yes: false }, { isTTY: true })).toBe('prod');
  });

  it('rejects names that cannot become a branch or server name', async () => {
    clackMock.text.mockResolvedValue('prod');
    await promptEnvironmentName({ env: null, yes: false }, { isTTY: true });
    const { validate } = clackMock.text.mock.calls[0][0];
    expect(validate('my env')).toBeTruthy();
    expect(validate('1prod')).toBeTruthy();
    expect(validate('staging-2')).toBeUndefined();
    expect(validate('')).toBeUndefined();
  });

  it.each([
    ['an env named on the command line', { env: 'staging', yes: false }, true, 'staging'],
    ['-y', { env: null, yes: true }, true, null],
    ['a non-interactive run', { env: null, yes: false }, false, null],
  ])('does not prompt for %s', async (_label, args, isTTY, expected) => {
    expect(await promptEnvironmentName(args, { isTTY })).toBe(expected);
    expect(clackMock.text).not.toHaveBeenCalled();
  });
});

// destroy carries `dnsProvider: 'manual'` (domain null) into the next deploy's
// seed, and a live env keeps it too, so the DNS prompt never came back.
describe('shouldReaskManualDns', () => {
  it('re-asks a saved manual pick that never got a domain', () => {
    expect(shouldReaskManualDns({ dnsProvider: null, yes: false }, 'manual', null)).toBe(true);
  });
  it('keeps manual when it has a domain the operator points by hand', () => {
    expect(shouldReaskManualDns({ dnsProvider: null, yes: false }, 'manual', 'a.example.com')).toBe(
      false,
    );
  });
  it('keeps an automated provider', () => {
    expect(shouldReaskManualDns({ dnsProvider: null, yes: false }, 'hetzner', null)).toBe(false);
  });
  it('stays silent under -y', () => {
    expect(shouldReaskManualDns({ dnsProvider: null, yes: true }, 'manual', null)).toBe(false);
  });
});
