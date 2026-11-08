/**
 * The step matrix must show what a step did, even after an earlier failure.
 *
 * A missed cold-deploy budget fails verify-deploy but lets the rest of the
 * lifecycle run (tests/unit/e2e/deploy-budget-continues.test.ts). The matrix
 * still painted every later cell `↷ blocked`: a linode/k8s run on 2026-11-08
 * showed 11 steps as blocked that had all run and passed, as the results db
 * recorded. It also never drew warm-redeploy-change, a step its hand-kept
 * order list did not name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logStepMatrix } from '../../e2e/metrics/reporter.js';
import { STEP_NAMES } from '../../e2e/scenarios/types.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertions
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n').replace(ANSI_RE, '');
}

afterEach(() => vi.restoreAllMocks());

const step = (name: string, status: string, durationMs: number) => ({ name, status, durationMs });
/** The step names down the matrix's first column, top to bottom. */
const rowNames = (out: string) =>
  out
    .split('\n')
    .map((l) => l.split('│')[1]?.trim())
    .filter((n): n is string => !!n && n !== 'Step');
/** The cells of one step's row, after the step name. */
const rowCells = (out: string, name: string) =>
  (out.split('\n').find((l) => l.split('│')[1]?.trim() === name) ?? '')
    .split('│')
    .slice(2, -1)
    .map((c) => c.trim());

describe('logStepMatrix after a failed step', () => {
  it('shows the steps that ran after it as they ran', () => {
    const out = capture(() =>
      logStepMatrix([
        {
          provider: 'linode',
          mode: 'k8s',
          steps: [
            step('deploy', 'pass', 302_389),
            step('verify-deploy', 'fail', 37_486),
            step('warm-deploy', 'pass', 6_307),
            step('warm-redeploy-change', 'pass', 44_295),
            step('scale', 'pass', 872_115),
            step('restore', 'skip', 0),
          ],
        },
      ]),
    );
    expect(rowCells(out, 'verify-deploy')).toEqual(['✗ FAIL 37.5s']);
    expect(rowCells(out, 'warm-deploy')).toEqual(['✓ 6.3s']);
    expect(rowCells(out, 'warm-redeploy-change')).toEqual(['✓ 44.3s']);
    expect(rowCells(out, 'scale')).toEqual(['✓ 14m 32s']);
    // A step the failure really did stop still reads as blocked.
    expect(rowCells(out, 'restore')).toEqual(['↷ blocked']);
  });

  it('marks a step another scenario ran, and this one never reached, as blocked', () => {
    const out = capture(() =>
      logStepMatrix([
        {
          provider: 'linode',
          mode: 'k8s',
          steps: [step('deploy', 'fail', 1_000)],
        },
        {
          provider: 'linode',
          mode: 'compose',
          steps: [step('deploy', 'pass', 1_000), step('backup', 'pass', 2_000)],
        },
      ]),
    );
    expect(rowCells(out, 'backup')).toEqual(['↷ blocked', '✓ 2.0s']);
  });

  it('draws a step its order list does not know, after the known ones', () => {
    const out = capture(() =>
      logStepMatrix([
        {
          provider: 'hetzner',
          mode: 'compose',
          steps: [step('deploy', 'pass', 1_000), step('some-new-step', 'pass', 3_000)],
        },
      ]),
    );
    expect(rowCells(out, 'some-new-step')).toEqual(['✓ 3.0s']);
    expect(rowNames(out)).toEqual(['deploy', 'some-new-step']);
  });

  it('draws its rows in lifecycle order, whatever order the results arrive in', () => {
    const out = capture(() =>
      logStepMatrix([
        {
          provider: 'hetzner',
          mode: 'k8s-ha',
          steps: [...STEP_NAMES].reverse().map((name) => step(name, 'pass', 1_000)),
        },
      ]),
    );
    expect(rowNames(out)).toEqual([...STEP_NAMES]);
    const names = rowNames(out);
    expect(names.indexOf('warm-redeploy-change')).toBe(names.indexOf('warm-deploy') + 1);
  });
});
