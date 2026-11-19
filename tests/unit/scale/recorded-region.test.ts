/**
 * scale works in the region the environment was deployed in, which every
 * deploy records before any remote work. A record without one was edited by
 * hand, and there is no right region to guess: a compose scale places the
 * replacement server there and a k8s scale feeds it to the cluster's Pulumi
 * program, so a wrong one builds servers where the environment is not. It
 * used to guess `fsn1`, a Hetzner location, for every provider. Now scale
 * refuses before any prompt or provider call and says what to add.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const errors: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note() {},
    outro() {},
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

let projectConfig: Record<string, unknown> = {};
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => projectConfig,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/project.js', () => ({ repairLegacyEnvQuoting: () => {} }));
// The project scaffold is current; the stale-scaffold refusal has its own tests.
vi.mock('../../../src/lib/deploy/preflight.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertScaffoldSupportsRoleFile: () => {},
}));

const { run } = await import('../../../src/scale.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const providerCalls: string[] = [];
beforeEach(() => {
  errors.length = 0;
  providerCalls.length = 0;
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new Exit(code as number);
  });
  for (const [id, Provider] of Object.entries(PROVIDERS)) {
    vi.spyOn(Provider, 'promptApiToken').mockImplementation(async () => {
      providerCalls.push(`${id}.promptApiToken`);
      return 'tok';
    });
    vi.spyOn(Provider, 'fetchServerTypes').mockImplementation(async () => {
      providerCalls.push(`${id}.fetchServerTypes`);
      return true;
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const TIERS = {
  compose: { deployMode: 'compose', servers: [{ id: 1, ip: '203.0.113.10' }] },
  k8s: { deployMode: 'kubernetes', masterIp: '203.0.113.10' },
};

describe('scale of an environment whose record names no region', () => {
  const cases = Object.keys(PROVIDERS).flatMap((provider) =>
    Object.keys(TIERS).map((tier) => [provider, tier] as const),
  );

  it.each(cases)(
    '%s %s: refuses before any provider call and names the fix',
    async (provider, tier) => {
      projectConfig = {
        projectName: 'proj',
        environments: {
          prod: { status: 'deployed', provider, ...TIERS[tier] },
        },
      };
      await expect(run(['prod', '-y'])).rejects.toEqual(new Exit(1));
      expect(errors).toEqual([
        'Refusing to scale "prod": its entry in .vibecarbon.json records no region, and a ' +
          'guessed one would build servers where the environment is not. add "region" (the ' +
          'region it was deployed in) to environments.prod in .vibecarbon.json, then scale again',
      ]);
      expect(providerCalls).toEqual([]);
    },
  );
});
