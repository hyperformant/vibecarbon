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
    ['kubernetes', { deployMode: 'kubernetes', ha: false }],
    ['kubernetes-ha', { deployMode: 'kubernetes', ha: true }],
  ])('maps the interactive selection %s', async (selected, expected) => {
    clackMock.select.mockResolvedValueOnce(selected);
    const result = await resolveDeployMode(noFlags, {});
    expect(result).toEqual(expected);
    expect(clackMock.select).toHaveBeenCalledTimes(1);
    clackMock.select.mockClear();
  });

  it('does not offer compose-ha on a provider that has Kubernetes', async () => {
    // compose-ha stays a supported mode (existing environments keep working,
    // the flag below still resolves, the e2e matrix still runs it) but it is
    // no longer RECOMMENDED: where Kubernetes HA is on offer, that is the HA
    // answer the picker leads with. See src/lib/deploy/prompts.js.
    clackMock.select.mockResolvedValueOnce('compose');
    await resolveDeployMode(noFlags, {}); // no provider -> hetzner, all four tiers

    const options = clackMock.select.mock.calls[0][0].options as { value: string }[];
    expect(options.map((o) => o.value)).toEqual(['compose', 'kubernetes', 'kubernetes-ha']);
    clackMock.select.mockClear();
  });

  it.each(['vultr', 'scaleway'])(
    'offers Compose HA on %s, which declares no Kubernetes tier',
    async (provider) => {
      // Vultr and Scaleway are SUPPORTED_TIERS = ['compose', 'compose-ha'].
      // Hiding compose-ha there would leave a one-option select and put the
      // only HA mode they can run behind a flag nobody was shown.
      clackMock.select.mockResolvedValueOnce('compose');
      await resolveDeployMode(noFlags, { provider });

      const options = clackMock.select.mock.calls[0][0].options as {
        value: string;
        hint: string;
      }[];
      expect(options.map((o) => o.value)).toEqual(['compose', 'compose-ha']);
      expect(options.find((o) => o.value === 'compose-ha')?.hint).toContain(
        'Enterprise resiliency, Fullerene',
      );
      clackMock.select.mockClear();
    },
  );

  it('maps a compose-ha picker selection on a compose-only provider', async () => {
    clackMock.select.mockResolvedValueOnce('compose-ha');
    const result = await resolveDeployMode(noFlags, { provider: 'vultr' });
    expect(result).toEqual({ deployMode: 'compose-ha', ha: true });
    clackMock.select.mockClear();
  });

  it('still resolves compose-ha when it is passed explicitly by flag', async () => {
    const result = await resolveDeployMode({ ...noFlags, compose: true, ha: true }, {});
    expect(result).toEqual({ deployMode: 'compose-ha', ha: true });
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('labels each picker choice with the benefit and the tier that unlocks it', async () => {
    clackMock.select.mockResolvedValueOnce('compose');
    await resolveDeployMode(noFlags, {});

    const options = clackMock.select.mock.calls[0][0].options as {
      value: string;
      hint: string;
    }[];
    const hintFor = (value: string) => options.find((o) => o.value === value)?.hint ?? '';
    expect(hintFor('compose')).toContain('Go live, Graphite');
    expect(hintFor('kubernetes')).toContain('Scale on demand, Graphene');
    expect(hintFor('kubernetes-ha')).toContain('Enterprise resiliency, Fullerene');
    // The old copy paywalled Kubernetes at the wrong tier.
    for (const o of options) expect(o.hint).not.toContain('requires Fullerene');
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
