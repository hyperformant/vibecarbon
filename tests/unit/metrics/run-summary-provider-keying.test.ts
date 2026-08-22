/**
 * The end-of-run summaries must key scenarios on provider/mode.
 *
 * Under `--provider all` the run contains hetzner/compose-ha AND
 * digitalocean/compose-ha. Keyed on bare mode, `logStepMatrix`'s step index
 * (`stepIndex[step][mode]`) let the second scenario overwrite the first: both
 * "compose-ha" columns rendered the same cloud's numbers, and a
 * Hetzner-only failure was attributed to whichever scenario wrote last.
 * `logRunSummary` had the same ambiguity in its Scenario column.
 *
 * Display drops the provider prefix on a single-provider run (by far the
 * common case) — but the KEY never does, which is what these tests pin.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { logRunSummary, logStepMatrix } from '../../e2e/metrics/reporter.js';

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

describe('logStepMatrix keys columns on provider/mode', () => {
  it('renders both same-mode scenarios of a multi-provider run instead of overwriting one', () => {
    const out = capture(() =>
      logStepMatrix([
        {
          provider: 'hetzner',
          mode: 'compose-ha',
          steps: [step('deploy', 'pass', 120_000)],
        },
        {
          provider: 'digitalocean',
          mode: 'compose-ha',
          steps: [step('deploy', 'pass', 300_000)],
        },
      ]),
    );

    expect(out).toContain('hetzner/compose-ha');
    expect(out).toContain('digitalocean/compose-ha');
    // Both clouds' own numbers survive — the collision used to leave only one.
    expect(out).toContain('2m 0s');
    expect(out).toContain('5m 0s');
  });

  it('attributes a failure to the failing provider only', () => {
    const out = capture(() =>
      logStepMatrix([
        {
          provider: 'hetzner',
          mode: 'k8s',
          steps: [step('deploy', 'pass', 60_000), step('scale', 'fail', 10_000)],
        },
        {
          provider: 'digitalocean',
          mode: 'k8s',
          steps: [step('deploy', 'pass', 60_000), step('scale', 'pass', 20_000)],
        },
      ]),
    );

    const scaleRow = out.split('\n').find((l) => l.includes('scale')) ?? '';
    const cells = scaleRow.split('│').map((c) => c.trim());
    // Column order follows the input order: [ , step, hetzner, digitalocean, ]
    expect(cells[2]).toContain('FAIL');
    expect(cells[3]).not.toContain('FAIL');
  });

  it('drops the provider prefix when the run is single-provider', () => {
    const out = capture(() =>
      logStepMatrix([
        { provider: 'hetzner', mode: 'compose', steps: [step('deploy', 'pass', 60_000)] },
        { provider: 'hetzner', mode: 'k8s', steps: [step('deploy', 'pass', 90_000)] },
      ]),
    );

    expect(out).not.toContain('hetzner/');
    expect(out).toContain('compose');
    expect(out).toContain('k8s');
  });
});

describe('logRunSummary labels scenarios by provider/mode', () => {
  it('distinguishes two same-mode scenarios from different providers', () => {
    const out = capture(() =>
      logRunSummary([
        { provider: 'hetzner', mode: 'compose-ha', status: 'pass', durationMs: 120_000 },
        {
          provider: 'digitalocean',
          mode: 'compose-ha',
          status: 'fail',
          durationMs: 300_000,
          failureCategory: 'infra',
        },
      ]),
    );

    expect(out).toContain('hetzner/compose-ha');
    expect(out).toContain('digitalocean/compose-ha');
    expect(out).toContain('(1/2 scenarios passed)');
  });

  it('drops the provider prefix when the run is single-provider', () => {
    const out = capture(() =>
      logRunSummary([{ provider: 'hetzner', mode: 'compose', status: 'pass', durationMs: 60_000 }]),
    );

    expect(out).not.toContain('hetzner/');
    expect(out).toContain('compose');
  });
});
