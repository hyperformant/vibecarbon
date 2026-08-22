/**
 * Unit tests for lib/deploy/prompts.js resolveDeployMode — the decision that
 * routes a deploy into compose / compose-ha / kubernetes / kubernetes-ha and
 * therefore which license gate fires. The non-interactive branches are pure;
 * the interactive branch is exercised through a mocked clack select.
 */

import { describe, expect, it, vi } from 'vitest';

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

import { resolveDeployMode } from '../../../src/lib/deploy/prompts.js';

const noFlags = { compose: false, k8s: false, ha: false, yes: false };

describe('resolveDeployMode', () => {
  it('respects an existing environment deployMode without prompting', async () => {
    const result = await resolveDeployMode(noFlags, {
      deployMode: 'compose-ha',
      ha: { enabled: true },
    });
    expect(result).toEqual({ deployMode: 'compose-ha', ha: true });
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('defaults ha=false when the saved env has no ha block', async () => {
    const result = await resolveDeployMode(noFlags, { deployMode: 'kubernetes' });
    expect(result).toEqual({ deployMode: 'kubernetes', ha: false });
  });

  it.each([
    [
      { compose: true, ha: true },
      { deployMode: 'compose-ha', ha: true },
    ],
    [{ compose: true }, { deployMode: 'compose', ha: false }],
    [
      { k8s: true, ha: true },
      { deployMode: 'kubernetes', ha: true },
    ],
    [{ k8s: true }, { deployMode: 'kubernetes', ha: false }],
    [{ ha: true }, { deployMode: 'kubernetes', ha: true }],
  ])('maps -mode flag shape %o without prompting', async (flags, expected) => {
    const result = await resolveDeployMode({ ...noFlags, ...flags }, {});
    expect(result).toEqual(expected);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('defaults to single-server compose under -y with no mode flags', async () => {
    const result = await resolveDeployMode({ ...noFlags, yes: true }, {});
    expect(result).toEqual({ deployMode: 'compose', ha: false });
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it.each([
    ['compose', { deployMode: 'compose', ha: false }],
    ['compose-ha', { deployMode: 'compose-ha', ha: true }],
    ['kubernetes', { deployMode: 'kubernetes', ha: false }],
    ['kubernetes-ha', { deployMode: 'kubernetes', ha: true }],
  ])('maps the interactive selection %s', async (selected, expected) => {
    clackMock.select.mockResolvedValueOnce(selected);
    const result = await resolveDeployMode(noFlags, {});
    expect(result).toEqual(expected);
    expect(clackMock.select).toHaveBeenCalledTimes(1);
    clackMock.select.mockClear();
  });

  it('exits 130 when the interactive prompt is cancelled', async () => {
    clackMock.select.mockResolvedValueOnce(Symbol.for('cancel'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit(130)');
    }) as never);
    await expect(resolveDeployMode(noFlags, {})).rejects.toThrow('process.exit(130)');
    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(clackMock.cancel).toHaveBeenCalledWith('Operation cancelled.');
    exitSpy.mockRestore();
  });
});
