/**
 * Unit tests for lib/deploy/prompts.js resolveDeployMode — the decision that
 * routes a deploy into compose / compose-ha / kubernetes / kubernetes-ha. The
 * non-interactive branches are pure;
 * the interactive branch is exercised through a mocked clack select.
 */

import { describe, expect, it, vi } from 'vitest';

const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({
    fns: ['select', 'cancel', 'text', 'confirm', 'password', 'note'],
    log: ['step', 'info', 'warn', 'error', 'success', 'message'],
    spinner: true,
    with: { isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')) },
  });
});
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
    ['kubernetes', { deployMode: 'kubernetes', ha: false }],
    ['kubernetes-ha', { deployMode: 'kubernetes', ha: true }],
  ])('maps the interactive selection %s', async (selected, expected) => {
    clackMock.select.mockResolvedValueOnce(selected);
    const result = await resolveDeployMode(noFlags, {});
    expect(result).toEqual(expected);
    expect(clackMock.select).toHaveBeenCalledTimes(1);
    clackMock.select.mockClear();
  });

  it('never offers compose-ha, which is not shipping, on a provider with Kubernetes', async () => {
    // compose-ha stays a working mode (existing environments keep working and
    // the flag below still resolves) but is not offered to a new environment
    // (OFFERED_TIERS in src/lib/deploy/tier-registry.js).
    clackMock.select.mockResolvedValueOnce('compose');
    await resolveDeployMode(noFlags, {}); // no provider -> hetzner, all four tiers

    const options = clackMock.select.mock.calls[0][0].options as { value: string }[];
    expect(options.map((o) => o.value)).toEqual(['compose', 'kubernetes', 'kubernetes-ha']);
    clackMock.select.mockClear();
  });

  it.each([
    ['vultr', 'Vultr'],
    ['scaleway', 'Scaleway'],
  ])(
    'deploys compose on %s without asking, since it is the one mode offered',
    async (provider, name) => {
      // Vultr and Scaleway support compose and compose-ha; with compose-ha not
      // offered, a select would have one choice, so the picker says what it
      // picked instead.
      clackMock.log.info.mockClear();
      const result = await resolveDeployMode(noFlags, { provider });

      expect(result).toEqual({ deployMode: 'compose', ha: false });
      expect(clackMock.select).not.toHaveBeenCalled();
      expect(clackMock.log.info).toHaveBeenCalledWith(
        `Deploy mode: Docker Compose (Fast), the one mode ${name} offers`,
      );
    },
  );

  it('still resolves compose-ha when it is passed explicitly by flag', async () => {
    const result = await resolveDeployMode({ ...noFlags, compose: true, ha: true }, {});
    expect(result).toEqual({ deployMode: 'compose-ha', ha: true });
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('labels each picker choice with the benefit it delivers', async () => {
    clackMock.select.mockResolvedValueOnce('compose');
    await resolveDeployMode(noFlags, {});

    const options = clackMock.select.mock.calls[0][0].options as {
      value: string;
      hint: string;
    }[];
    const hintFor = (value: string) => options.find((o) => o.value === value)?.hint ?? '';
    expect(hintFor('compose')).toContain('Go live');
    expect(hintFor('kubernetes')).toContain('Scale on demand');
    expect(hintFor('kubernetes-ha')).toContain('Enterprise resiliency');
    // Tier names are retired from the picker.
    for (const o of options) expect(o.hint).not.toMatch(/Graphite|Graphene|Fullerene/);
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
