/**
 * gitScrubbedEnv (tests/_shared/git-env.ts) — the one env builder for
 * test-spawned git. See its module doc for the two GIT_DIR hook-leak
 * incidents it exists to prevent. These pins are what the registry row in
 * shared-helper-consumers.test.ts points at as deep coverage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitScrubbedEnv } from '../../_shared/git-env.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gitScrubbedEnv', () => {
  it('strips every repo-targeting var git exports to hooks', () => {
    for (const v of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_PREFIX',
      'GIT_OBJECT_DIRECTORY',
      'GIT_QUARANTINE_PATH',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CEILING_DIRECTORIES',
    ]) {
      vi.stubEnv(v, '/somewhere/real-repo/.git');
    }
    const env = gitScrubbedEnv();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.GIT_PREFIX).toBeUndefined();
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(env.GIT_QUARANTINE_PATH).toBeUndefined();
    // Not write hazards, but companions of the two above (alternate object
    // stores, discovery ceiling) — stripped for set coherence.
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(env.GIT_CEILING_DIRECTORIES).toBeUndefined();
  });

  it('keeps transport/safety vars — the e2e setup-repo push depends on them', () => {
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh -i /tmp/key');
    vi.stubEnv('GIT_ASKPASS', '/bin/false');
    vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
    const env = gitScrubbedEnv();
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /tmp/key');
    expect(env.GIT_ASKPASS).toBe('/bin/false');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('does not touch global/system config by default', () => {
    const env = gitScrubbedEnv();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.GIT_CONFIG_SYSTEM).toBeUndefined();
  });

  it('isolateConfig pins global/system config to /dev/null (identity firewall)', () => {
    const env = gitScrubbedEnv({ isolateConfig: true });
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
  });

  it('returns a copy — mutating the result never leaks into process.env', () => {
    const env = gitScrubbedEnv();
    env.GIT_DIR = '/poisoned';
    expect(process.env.GIT_DIR).not.toBe('/poisoned');
  });
});
