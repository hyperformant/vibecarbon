import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * runProjectAssignment — the best-effort call-site wrapper around
 * provider.ensureProjectAssignment. Deploy/scale call it AFTER their work
 * succeeded; organizational filing must never turn that success into a
 * failure, so the wrapper warns-and-returns-null on any provider throw. It
 * also owns persistence: the provider returns the resolved project id and
 * the wrapper writes it to .env.local (localOnly) + process.env so later
 * deploys skip the find-or-create.
 */

const setEnvVarMock = vi.fn();
vi.mock('../../../src/lib/project.js', () => ({
  setEnvVar: (...args: unknown[]) => setEnvVarMock(...args),
}));

const logWarnMock = vi.fn();
const logInfoMock = vi.fn();
vi.mock('@clack/prompts', () => ({
  log: {
    warn: (...args: unknown[]) => logWarnMock(...args),
    info: (...args: unknown[]) => logInfoMock(...args),
  },
}));

import { runProjectAssignment } from '../../../src/lib/project-assignment.js';

class FakeDoProvider {
  static PROJECT_ID_ENV = 'DIGITALOCEAN_PROJECT_ID';
  result: unknown;
  error: Error | null = null;
  async ensureProjectAssignment() {
    if (this.error) throw this.error;
    return this.result;
  }
}

class FakeNoopProvider {
  async ensureProjectAssignment() {
    return null;
  }
}

beforeEach(() => {
  setEnvVarMock.mockReset();
  logWarnMock.mockReset();
  logInfoMock.mockReset();
  delete process.env.DIGITALOCEAN_PROJECT_ID;
});

describe('runProjectAssignment', () => {
  it('returns null and persists nothing for a provider whose no-op is the correct implementation', async () => {
    const result = await runProjectAssignment(new FakeNoopProvider(), {
      projectName: 'newapp',
      environment: 'prod',
    });
    expect(result).toBeNull();
    expect(setEnvVarMock).not.toHaveBeenCalled();
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it('persists the resolved project id to .env.local (localOnly) and process.env', async () => {
    const provider = new FakeDoProvider();
    provider.result = { projectId: 'p-123', created: true, assigned: 2 };

    const result = await runProjectAssignment(provider, {
      projectName: 'newapp',
      environment: 'prod',
    });

    expect(result).toEqual({ projectId: 'p-123', created: true, assigned: 2 });
    expect(process.env.DIGITALOCEAN_PROJECT_ID).toBe('p-123');
    expect(setEnvVarMock).toHaveBeenCalledTimes(1);
    const [key, value, , opts] = setEnvVarMock.mock.calls[0];
    expect(key).toBe('DIGITALOCEAN_PROJECT_ID');
    expect(value).toBe('p-123');
    expect(opts).toEqual({ localOnly: true });
  });

  it('does not re-write the env var when it already holds the resolved id', async () => {
    process.env.DIGITALOCEAN_PROJECT_ID = 'p-123';
    const provider = new FakeDoProvider();
    provider.result = { projectId: 'p-123', created: false, assigned: 1 };

    await runProjectAssignment(provider, { projectName: 'newapp', environment: 'prod' });

    expect(setEnvVarMock).not.toHaveBeenCalled();
  });

  it('warns and returns null when the provider throws — a succeeded deploy must stay succeeded', async () => {
    const provider = new FakeDoProvider();
    provider.error = new Error('listing broke');

    const result = await runProjectAssignment(provider, {
      projectName: 'newapp',
      environment: 'prod',
    });

    expect(result).toBeNull();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(String(logWarnMock.mock.calls[0][0])).toContain('listing broke');
  });
});

describe('call-site wiring census', () => {
  // The helper only matters if the two resource-creating verbs actually call
  // it. Source-pin both call sites so deleting either wire fails here, not
  // in a live deploy.
  const ROOT = join(__dirname, '..', '..', '..');
  it.each([['src/lib/deploy/orchestrator.js'], ['src/scale.js']])(
    '%s calls runProjectAssignment',
    (rel) => {
      const source = readFileSync(join(ROOT, rel), 'utf-8');
      expect(source).toMatch(/runProjectAssignment\(/);
    },
  );
});
