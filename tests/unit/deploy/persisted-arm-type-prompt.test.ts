/**
 * The deploy prompt path (lib/deploy/prompts.js gatherDeploymentConfig)
 * refuses an ARM server type persisted in .vibecarbon.json. Arch audit
 * 2026-10-15: Scaleway's STANDARD2-A* line is arm64 and used to pass the
 * name-only guard. A hand-edited (or pre-guard) .vibecarbon.json is the one
 * path that reaches Pulumi without a prompt, so the run must stop with the
 * guard's message before any provisioning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const errors: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note() {},
    select: async () => {
      throw new Error('unexpected prompt');
    },
    spinner: () => ({ start() {}, stop() {}, message() {} }),
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
vi.mock('../../../src/lib/colors.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  printBanner() {},
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice() {} }));
vi.mock('../../../src/lib/deploy/preflight.js', () => ({ assertOperatorConfig() {} }));

let projectConfig: Record<string, unknown> = {};
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProjectConfig: () => projectConfig,
}));

const { gatherDeploymentConfig } = await import('../../../src/lib/deploy/prompts.js');
const { ScalewayProvider } = await import('../../../src/lib/providers/scaleway.js');

class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors.length = 0;
  // Never a real credential from the shell: past the guard the run must stop
  // at the first credential prompt, not reach a live API.
  for (const key of ['SCALEWAY_ACCESS_KEY', 'SCALEWAY_SECRET_KEY', 'SCALEWAY_DEFAULT_PROJECT_ID']) {
    vi.stubEnv(key, '');
  }
  vi.spyOn(console, 'clear').mockImplementation(() => {});
  vi.spyOn(ScalewayProvider, 'promptApiToken').mockResolvedValue('scw-token');
  // No live catalog: the guard falls back to its name rule, which must still
  // classify STANDARD2-A* as arm64.
  vi.spyOn(ScalewayProvider, 'fetchServerTypes').mockResolvedValue(undefined as never);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  exitSpy.mockRestore();
});

describe('deploy refuses a persisted ARM server type', () => {
  it('Scaleway compose with serverType STANDARD2-A2C-8G in .vibecarbon.json', async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: {
          provider: 'scaleway',
          deployMode: 'compose',
          region: 'fr-par-1',
          domain: 'example.com',
          serverType: 'STANDARD2-A2C-8G',
        },
      },
    };
    await expect(gatherDeploymentConfig({ env: 'prod', yes: true })).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toContain(
      ".vibecarbon.json serverType: 'STANDARD2-A2C-8G' is an ARM (aarch64) Scaleway server type.",
    );
  });

  it('an x86 type in the same place passes the guard', async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: {
          provider: 'scaleway',
          deployMode: 'compose',
          region: 'fr-par-1',
          domain: 'example.com',
          serverType: 'BASIC3-X2C-4G',
        },
      },
    };
    // The run gets past the guard to the next credential (the S3 key, which a
    // non-TTY test cannot supply) instead of exiting on the type.
    const err = await gatherDeploymentConfig({ env: 'prod', yes: true }).catch((e) => e);
    expect(err).not.toBeInstanceOf(ExitError);
    expect(errors.join('\n')).not.toContain('is an ARM');
  });
});
