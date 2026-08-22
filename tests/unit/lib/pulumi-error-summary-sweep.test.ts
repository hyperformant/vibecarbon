import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summarizePulumiError } from '../../../src/lib/iac/index.js';

// Call-site sweep for the `code: -2` defect.
//
// The Pulumi automation API's CommandError message is an ENVELOPE:
//
//     code: -2
//     stdout: …
//     stderr: …
//
// so the near-universal `err.message.split('\n')[0]` yields the literal string
// `code: -2` and discards everything that matters. #248 introduced
// summarizePulumiError and wired it into convergeClusterInfra's two aborts,
// but eight other sites kept truncating — including, in the same file that
// documents the defect, the diagnostic for the decision NOT to re-run `up`
// on the stale-state recovery path.
//
// It cost a real RCA: the 2026-08-06 k8s-ha record attempt reported
// `HA deploy failed — primary: code: -2` and nothing else, leaving the
// failure to be reconstructed from perf timings.
//
// A unit test of summarizePulumiError itself cannot catch this — the helper
// was always correct; the bug was every call site that didn't use it. So this
// sweeps for the truncation pattern across the Pulumi-facing modules instead.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Modules that format errors originating from the automation API. */
const PULUMI_FACING = [
  'src/lib/iac',
  'src/lib/deploy/effects/k8s-ha.js',
  'src/lib/deploy/effects/compose-ha.js',
];

function filesUnder(rel: string): string[] {
  const abs = join(repoRoot, rel);
  if (!/\.js$/.test(rel)) {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => join(abs, e.name));
  }
  return [abs];
}

describe('Pulumi errors are summarized, never first-line-truncated', () => {
  it('no Pulumi-facing module truncates an error with split()[0]', () => {
    const offenders: string[] = [];
    for (const target of PULUMI_FACING) {
      for (const file of filesUnder(target)) {
        readFileSync(file, 'utf-8')
          .split('\n')
          .forEach((line, i) => {
            if (/^\s*(\*|\/\/)/.test(line)) return; // prose explaining the defect
            if (/\.split\(['"]\\n['"]\)\[0\]/.test(line)) {
              offenders.push(`${relative(repoRoot, file)}:${i + 1}`);
            }
          });
      }
    }
    expect(
      offenders,
      'The automation API error envelope STARTS with `code: N`, so first-line ' +
        'truncation prints `code: -2` and throws the real error away. Use ' +
        'summarizePulumiError(err) instead:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('summarizePulumiError digs the real error out of a CommandError envelope', () => {
    const envelope = new Error(
      ['code: -2', 'stdout: Updating (e4-primary)', 'stderr: ', 'err?: exit status 255'].join('\n'),
    );
    expect(summarizePulumiError(envelope)).not.toBe('code: -2');
    expect(summarizePulumiError(envelope)).not.toMatch(/^code:\s*-?\d+$/);
  });

  it('prefers a top-level `error:` line over the envelope header', () => {
    const err = new Error(
      ['code: -2', 'stdout: ...', 'error: creating server: resource_unavailable'].join('\n'),
    );
    expect(summarizePulumiError(err)).toBe('error: creating server: resource_unavailable');
  });
});
