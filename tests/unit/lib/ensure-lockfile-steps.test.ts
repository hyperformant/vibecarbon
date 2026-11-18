/**
 * ensureLockfile writes the lockfile for the deploy preflight and for
 * `vibecarbon create`. These pin the sequence create's spinner and error block
 * rely on: each step's line, a repaint (tick) before the first install and
 * after every install, npm's `npm ci --dry-run` check between passes, and the
 * exact install argv and options create ran before it shared this loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('../../../src/lib/command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/command.js')>()),
  runCommand,
}));

import { ensureLockfile, MAX_LOCKFILE_PASSES } from '../../../src/lib/package-manager.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const NPM_INSTALL = 'npm install --no-audit --no-fund';
const NPM_CHECK = 'npm ci --dry-run --no-audit --no-fund';

let dir: string;
let events: string[];
/** What each `npm ci --dry-run` answers, in order: null is a rejection. */
let checks: (string | null)[];

beforeEach(() => {
  dir = createTempDir('vc-ensure-lockfile-');
  events = [];
  checks = [];
  runCommand.mockReset();
  runCommand.mockImplementation((argv: string[]) => {
    events.push(`run ${argv.join(' ')}`);
    return argv[1] === 'ci' ? (checks.shift() ?? null) : '';
  });
});

const opts = (startMessage?: string) => ({
  onStep: (m: string) => events.push(`step ${m}`),
  tick: async () => {
    events.push('tick');
  },
  ...(startMessage ? { startMessage } : {}),
});

describe('ensureLockfile steps', () => {
  it('npm: start line, a repaint around the install, and a reconcile pass until npm ci accepts', async () => {
    checks = [null, 'ok'];
    const result = await ensureLockfile(dir, 'npm', opts('Installing dependencies'));
    expect(events).toEqual([
      'step Installing dependencies',
      'tick',
      `run ${NPM_INSTALL}`,
      'tick',
      `run ${NPM_CHECK}`,
      `step Reconciling package-lock.json (pass 2/${MAX_LOCKFILE_PASSES})`,
      `run ${NPM_INSTALL}`,
      'tick',
      `run ${NPM_CHECK}`,
    ]);
    expect(result.accepted).toBe(true);
    expect(runCommand.mock.calls.map(([, o]) => o)).toEqual([
      { cwd: dir, cleanEnv: true, ignoreError: true },
      { cwd: dir, cleanEnv: true, ignoreError: true, silent: true },
      { cwd: dir, cleanEnv: true, ignoreError: true },
      { cwd: dir, cleanEnv: true, ignoreError: true, silent: true },
    ]);
  });

  it('npm: gives up after MAX_LOCKFILE_PASSES checks, with one fewer reconcile', async () => {
    const result = await ensureLockfile(dir, 'npm', opts());
    expect(MAX_LOCKFILE_PASSES).toBe(5);
    expect(events.filter((e) => e === `run ${NPM_CHECK}`)).toHaveLength(MAX_LOCKFILE_PASSES);
    expect(events.filter((e) => e === `run ${NPM_INSTALL}`)).toHaveLength(MAX_LOCKFILE_PASSES);
    expect(events[0]).toBe('step Generating package-lock.json (required by the Docker build)');
    expect(events.at(-1)).toBe(`run ${NPM_CHECK}`);
    expect(result).toEqual({ lockfile: 'package-lock.json', generated: false, accepted: false });
  });

  it.each([
    ['pnpm', 'pnpm install --lockfile-only', 'pnpm-lock.yaml'],
    ['bun', 'bun install', 'bun.lock'],
  ] as const)('%s: one install between repaints, no npm check', async (pm, install, lockfile) => {
    const result = await ensureLockfile(dir, pm, opts('Start'));
    expect(events).toEqual(['step Start', 'tick', `run ${install}`, 'tick']);
    expect(result).toEqual({ lockfile, generated: false, accepted: false });
  });
});
