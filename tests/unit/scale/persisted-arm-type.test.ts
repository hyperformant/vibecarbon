import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Arch audit 2026-10-15 (F2, F4): `scale` must refuse an ARM server type
// whether it arrives as `-type` or is reused from .vibecarbon.json with no
// flag (k8s converge re-feed and the CA worker-pool re-patch), with the same
// guard message either way. Everything past the guard is mocked away: the run
// must stop at process.exit(1) before any provider or Pulumi work.

const errors: string[] = [];
const prompted = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note() {},
    outro() {},
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    multiselect: async () => {
      prompted.calls.push('multiselect');
      return [];
    },
    select: async () => {
      prompted.calls.push('select');
      return undefined;
    },
    log: {
      info() {},
      warn() {},
      step() {},
      success() {},
      message() {},
      error: (msg: string) => errors.push(msg),
    },
  };
});

let projectConfig: Record<string, unknown> = {};
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => projectConfig,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/project.js', () => ({ repairLegacyEnvQuoting: () => {} }));
vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // No saved token: scaleK8s skips the live catalog fetch.
  return { ...actual, resolveProviderToken: () => null };
});

const { run } = await import('../../../src/scale.js');
const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');

class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors.length = 0;
  prompted.calls.length = 0;
  vi.mocked(convergeClusterInfra).mockClear();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
});

function project(env: Record<string, unknown>) {
  return { projectName: 'proj', environments: { prod: { status: 'deployed', ...env } } };
}

describe('scale refuses ARM server types', () => {
  it('k8s with no -type refuses an ARM type persisted in .vibecarbon.json', async () => {
    projectConfig = project({
      provider: 'hetzner',
      deployMode: 'kubernetes',
      region: 'fsn1',
      serverType: 'cpx22',
      workerServerType: 'cax21',
    });
    await expect(run(['prod', '-y'])).rejects.toThrow(ExitError);
    expect(errors.join('\n')).toContain(
      ".vibecarbon.json workerServerType: 'cax21' is an ARM (aarch64) Hetzner Cloud server type.",
    );
    expect(convergeClusterInfra).not.toHaveBeenCalled();
  });

  it('k8s with no -type names serverType when the unified default is ARM', async () => {
    projectConfig = project({
      provider: 'hetzner',
      deployMode: 'kubernetes',
      region: 'fsn1',
      serverType: 'cax11',
    });
    await expect(run(['prod', '-y'])).rejects.toThrow(ExitError);
    expect(errors.join('\n')).toContain(".vibecarbon.json serverType: 'cax11' is an ARM");
  });

  it('the persisted refusal reads the same as the -type refusal', async () => {
    projectConfig = project({
      provider: 'hetzner',
      deployMode: 'kubernetes',
      region: 'fsn1',
      serverType: 'cpx22',
    });
    await expect(run(['prod', '-y', '-type', 'cax21'])).rejects.toThrow(ExitError);
    const flagMsg = errors.join('\n');
    expect(flagMsg).toContain("-type: 'cax21' is an ARM (aarch64) Hetzner Cloud server type.");

    errors.length = 0;
    projectConfig = project({
      provider: 'hetzner',
      deployMode: 'kubernetes',
      region: 'fsn1',
      serverType: 'cpx22',
      workerServerType: 'cax21',
    });
    await expect(run(['prod', '-y'])).rejects.toThrow(ExitError);
    const persistedMsg = errors.join('\n');
    const body = (m: string) => m.slice(m.indexOf("'cax21'"));
    expect(body(persistedMsg)).toBe(body(flagMsg));
  });

  it('Scaleway compose: -type STANDARD2-A2C-8G is refused', async () => {
    projectConfig = project({
      provider: 'scaleway',
      deployMode: 'compose',
      region: 'fr-par-1',
      serverType: 'BASIC3-X2C-4G',
    });
    await expect(run(['prod', '-y', '-type', 'STANDARD2-A2C-8G'])).rejects.toThrow(ExitError);
    expect(errors.join('\n')).toContain(
      "-type: 'STANDARD2-A2C-8G' is an ARM (aarch64) Scaleway server type.",
    );
  });

  it('k8s with -type but no -y still refuses an ARM type persisted for the other roles, before any prompt', async () => {
    projectConfig = project({
      provider: 'hetzner',
      deployMode: 'kubernetes',
      region: 'fsn1',
      serverType: 'cpx22',
      dbServerType: 'cax21',
    });
    // Without -y there is no scripted plan: the multiselect may resize any
    // subset, so every persisted role is checked up front.
    await expect(run(['prod', '-type', 'cpx32'])).rejects.toThrow(ExitError);
    expect(errors.join('\n')).toContain(
      ".vibecarbon.json dbServerType: 'cax21' is an ARM (aarch64) Hetzner Cloud server type.",
    );
    expect(prompted.calls).toEqual([]);
    expect(convergeClusterInfra).not.toHaveBeenCalled();
  });

  it('k8s -y -type resizes every role, so persisted ARM types are not in the way', async () => {
    projectConfig = project({
      provider: 'hetzner',
      deployMode: 'kubernetes',
      region: 'fsn1',
      serverType: 'cpx22',
      workerServerType: 'cax21',
    });
    // Past the guard the scripted plan resizes every role and the run asks
    // for an API token. A refused token is the next stop, so reaching it
    // proves the guard let the run through.
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    const token = vi.spyOn(HetznerProvider, 'promptApiToken').mockResolvedValue(null as never);
    try {
      await expect(run(['prod', '-y', '-type', 'cpx32'])).rejects.toThrow(ExitError);
      expect(token).toHaveBeenCalledTimes(1);
      expect(errors).toEqual(['API token required for server type changes']);
    } finally {
      token.mockRestore();
    }
  });
});
