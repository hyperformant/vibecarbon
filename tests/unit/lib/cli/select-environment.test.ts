import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @clack/prompts before importing the module under test so the
// import binding picks up the mocked symbols.
vi.mock('@clack/prompts', () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
  },
  select: vi.fn(),
  cancel: vi.fn(),
  // The real isCancel checks for a specific symbol; in tests we just
  // identify our sentinel value and treat that as "cancelled."
  isCancel: vi.fn((v: unknown) => v === '__CANCEL__'),
}));

const originalExit = process.exit;

beforeEach(() => {
  vi.clearAllMocks();
  process.exit = vi.fn((_code?: number) => {
    throw new Error(`process.exit:${_code}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
});

describe('selectEnvironment', () => {
  it('exits 1 with a verb-aware empty-state message when no envs are deployed', async () => {
    const { selectEnvironment } = await import('../../../../src/lib/cli/select-environment.js');
    const p = await import('@clack/prompts');
    await expect(
      selectEnvironment({ environments: {} }, { actionVerb: 'back up', seed: null }),
    ).rejects.toThrow('process.exit:1');
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining('back up'));
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining('vibecarbon deploy'));
  });

  it('exits 1 when the seeded env name is not in the project', async () => {
    const { selectEnvironment } = await import('../../../../src/lib/cli/select-environment.js');
    const p = await import('@clack/prompts');
    await expect(
      selectEnvironment(
        { environments: { prod: { status: 'deployed' } } },
        { actionVerb: 'back up', seed: 'staging' },
      ),
    ).rejects.toThrow('process.exit:1');
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("'staging' not found"));
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining('prod'));
  });

  it('returns the seeded env without prompting when it exists', async () => {
    const { selectEnvironment } = await import('../../../../src/lib/cli/select-environment.js');
    const p = await import('@clack/prompts');
    const result = await selectEnvironment(
      { environments: { prod: { status: 'deployed', region: 'hel1' } } },
      { actionVerb: 'back up', seed: 'prod' },
    );
    expect(result.envName).toBe('prod');
    expect(result.envConfig).toEqual({ status: 'deployed', region: 'hel1' });
    expect(p.select).not.toHaveBeenCalled();
  });

  it('skips the prompt and surfaces a log line when only one env exists', async () => {
    const { selectEnvironment } = await import('../../../../src/lib/cli/select-environment.js');
    const p = await import('@clack/prompts');
    const result = await selectEnvironment(
      { environments: { prod: { status: 'deployed' } } },
      { actionVerb: 'deploy to', seed: null },
    );
    expect(result.envName).toBe('prod');
    expect(p.select).not.toHaveBeenCalled();
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining('only deployed env'));
  });

  it('prompts with a verb-aware message when multiple envs exist', async () => {
    const p = await import('@clack/prompts');
    (p.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce('staging');

    const { selectEnvironment } = await import('../../../../src/lib/cli/select-environment.js');
    const result = await selectEnvironment(
      {
        environments: {
          prod: { status: 'deployed', region: 'hel1', servers: [{ ip: '1.2.3.4' }] },
          staging: { status: 'deployed', region: 'nbg1', servers: [{ ip: '5.6.7.8' }] },
        },
      },
      { actionVerb: 'restore', seed: null },
    );

    expect(p.select).toHaveBeenCalledTimes(1);
    const call = (p.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      message: string;
      options: Array<{ value: string; label: string; hint?: string }>;
    };
    expect(call.message).toContain('restore');
    expect(call.options.map((o) => o.value)).toEqual(['prod', 'staging']);
    // Hint surfaces deploy state + region + IP so operators can pick by metadata.
    expect(call.options[0].hint).toContain('deployed');
    expect(call.options[0].hint).toContain('hel1');
    expect(call.options[0].hint).toContain('1.2.3.4');

    expect(result.envName).toBe('staging');
    expect(result.envConfig.region).toBe('nbg1');
  });

  it('exits 130 when the operator cancels the prompt', async () => {
    const p = await import('@clack/prompts');
    (p.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce('__CANCEL__');

    const { selectEnvironment } = await import('../../../../src/lib/cli/select-environment.js');
    await expect(
      selectEnvironment(
        {
          environments: {
            prod: { status: 'deployed' },
            staging: { status: 'deployed' },
          },
        },
        { actionVerb: 'destroy', seed: null },
      ),
    ).rejects.toThrow('process.exit:130');
    expect(p.cancel).toHaveBeenCalled();
  });
});
