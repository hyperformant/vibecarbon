/**
 * runCiSweep (tests/e2e/utils/sweep-ci.ts): what every per-provider CI
 * safety-net sweep does around its own sweep.
 *
 * The exit code is the step's verdict in e2e-us-perf.yml. A sweep that could
 * not look at everything must fail the step (exit 1), or residue it never saw
 * bills under a green run; a missing token must not (exit 0), or every leg
 * goes red for a provider nobody configured. sweep-ci-entry-points.test.ts
 * runs the four scripts themselves on the no-token path; the paths with a
 * token need a sweep, which is a fake here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SweepBreakdown } from '../../e2e/metrics/db.js';
import { runCiSweep } from '../../e2e/utils/sweep-ci.js';

const TOKEN_ENV = 'SWEEP_CI_TEST_TOKEN';
const counts: SweepBreakdown = {
  servers: 1,
  volumes: 0,
  placementGroups: 0,
  firewalls: 0,
  floatingIps: 0,
  networks: 0,
  s3Buckets: 0,
  sshKeys: 0,
};

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

let logged: string[];
const saved = { token: process.env[TOKEN_ENV], namespace: process.env.E2E_NAMESPACE };

beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line) => void logged.push(String(line)));
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exit(code as number | undefined);
  });
  process.env[TOKEN_ENV] = 'tok';
  process.env.E2E_NAMESPACE = 'ci';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of [
    [TOKEN_ENV, saved.token],
    ['E2E_NAMESPACE', saved.namespace],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const run = (sweep: Parameters<typeof runCiSweep>[0]['sweep']) =>
  runCiSweep({ tag: '[sweep-x-ci]', tokenEnv: TOKEN_ENV, cloud: 'X', sweep });

describe('runCiSweep', () => {
  it('hands the sweep the namespace prefix and the token, prints the counts, and returns', async () => {
    const sweep = vi.fn().mockResolvedValue({ counts, enumFailed: false });
    await run(sweep);
    expect(sweep.mock.calls).toEqual([['citest-', 'tok']]);
    expect(logged).toEqual([`[sweep-x-ci] citest-*: ${JSON.stringify(counts)}`]);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('uses the local prefix when no namespace is set', async () => {
    delete process.env.E2E_NAMESPACE;
    const sweep = vi.fn().mockResolvedValue({ counts, enumFailed: false });
    await run(sweep);
    expect(sweep.mock.calls).toEqual([['testapp-', 'tok']]);
  });

  it('exits 1 when the sweep could not look at everything, after printing the counts', async () => {
    const sweep = vi.fn().mockResolvedValue({ counts, enumFailed: true });
    await expect(run(sweep)).rejects.toEqual(new Exit(1));
    expect(logged).toEqual([`[sweep-x-ci] citest-*: ${JSON.stringify(counts)}`]);
  });

  it('a sweep that deleted residue and read everything is not a failed step', async () => {
    // The sweep's own REGRESSION banner reports the residue; the exit code
    // speaks only for whether the sweep could look.
    const sweep = vi.fn().mockResolvedValue({ counts, enumFailed: false });
    await expect(run(sweep)).resolves.toBeUndefined();
  });

  it('without the token: says which variable, exits 0, and never starts the sweep', async () => {
    for (const blank of [undefined, '']) {
      logged = [];
      if (blank === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = blank;
      const sweep = vi.fn();
      await expect(run(sweep)).rejects.toEqual(new Exit(0));
      expect(sweep).not.toHaveBeenCalled();
      expect(logged).toEqual([
        `[sweep-x-ci] ${TOKEN_ENV} not set — skipping (no X secrets configured).`,
      ]);
    }
  });
});
