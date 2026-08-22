/**
 * pmScrubbedEnv (tests/_shared/pm-env.ts) — the one env builder for
 * test-spawned `vibecarbon create`. See its module doc for the two rounds of
 * runner-inherited package-manager detection it exists to prevent. These pins
 * are what the registry row in shared-helper-consumers.test.ts points at as
 * deep coverage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pmScrubbedEnv } from '../../_shared/pm-env.js';
import { e2eCliEnv } from '../../e2e/utils/e2e-env.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pmScrubbedEnv', () => {
  it('drops the user agent, so a fixture spawns the real default', () => {
    vi.stubEnv('npm_config_user_agent', 'pnpm/11.18.0 npm/? node/v24.15.0 linux x64');
    expect(pmScrubbedEnv().npm_config_user_agent).toBeUndefined();
  });

  it('drops the whole lowercase namespace, not just the user agent', () => {
    // SUPERSEDES an earlier assertion here that the rest of the lowercase
    // `npm_config_*` surface was KEPT, on the reasoning that a private registry
    // or proxy would otherwise break. That reasoning survives — it just moved
    // to the UPPERCASE spelling (below), because lowercase turned out not to be
    // the user's at all: it is what pnpm/bun project from their own resolved
    // config, and on 2026-08-05 npm 12 began hard-erroring on part of it
    // (EALLOWSCRIPTS). Keeping the lowercase surface meant keeping the leak.
    vi.stubEnv('npm_config_registry', 'https://registry.internal/');
    vi.stubEnv('npm_config_allow_scripts', 'vibecarbon');
    vi.stubEnv('pnpm_config_verify_deps_before_run', 'false');
    const env = pmScrubbedEnv();
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.npm_config_allow_scripts).toBeUndefined();
    expect(env.pnpm_config_verify_deps_before_run).toBeUndefined();
  });

  it('keeps UPPERCASE NPM_CONFIG_* — the spelling a human or CI actually uses', () => {
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://registry.internal/');
    expect(pmScrubbedEnv().NPM_CONFIG_REGISTRY).toBe('https://registry.internal/');
  });

  it('composes with another scrubbed env rather than resetting it', () => {
    // create.test.ts spawns git-touching fixtures too; the two scrubs have to
    // stack, not overwrite each other.
    const base = { PATH: '/usr/bin', GIT_DIR: undefined, npm_config_user_agent: 'bun/1.2.0' };
    const env = pmScrubbedEnv(base);
    expect(env.npm_config_user_agent).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('returns a copy — mutating the result never leaks into process.env', () => {
    vi.stubEnv('npm_config_user_agent', 'pnpm/11.18.0');
    const env = pmScrubbedEnv();
    env.npm_config_user_agent = 'poisoned';
    expect(process.env.npm_config_user_agent).not.toBe('poisoned');
  });
});

describe('e2eCliEnv routes the CLI child env through it', () => {
  it('does not hand the runner package manager to a spawned `create`', () => {
    // REGRESSION (2026-07-31, first real-infra run of the npm template): the
    // harness is launched by `pnpm test:e2e`, and e2eCliEnv spread
    // `process.env` wholesale — so every e2e `create` saw a pnpm user agent
    // and built a pnpm project. The matrix therefore never exercised the npm
    // default a customer gets, and the run failed inside the pnpm path, on
    // `pnpm install --frozen-lockfile` in the generated Dockerfile.
    const env = e2eCliEnv({}, {
      PATH: '/usr/bin',
      npm_config_user_agent: 'pnpm/11.18.0 npm/? node/v24.18.1 linux x64',
    } as NodeJS.ProcessEnv);

    expect(env.npm_config_user_agent).toBeUndefined();
    // Everything else the harness depends on still comes through.
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ALLOWED_SSH_IPS).toBe('0.0.0.0/0,::/0');
  });

  it('still lets an explicit per-call override through', () => {
    const env = e2eCliEnv({ npm_config_user_agent: 'bun/1.2.0' }, {
      PATH: '/usr/bin',
      npm_config_user_agent: 'pnpm/11.18.0',
    } as NodeJS.ProcessEnv);
    expect(env.npm_config_user_agent).toBe('bun/1.2.0');
  });
});
