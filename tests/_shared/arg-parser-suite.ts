/**
 * Shared cases for command "SPEC + parseFlags" integration tests.
 *
 * Every command's arg-parser test used to re-implement these three blocks
 * near-verbatim (boolean flags, env seeding, the single-dash-only rejection).
 * Call them inside the command's describe(); bespoke cases (enum values,
 * removed-flag regressions, end-to-end scripted invocations) stay inline in
 * each file.
 */

import { expect, it } from 'vitest';
import { parseFlags } from '../../src/lib/cli/parse-flags.js';

type Spec = Parameters<typeof parseFlags>[1];

/** Each named boolean flag parses to true when present. */
export function itParsesBooleanFlags(SPEC: Spec, flags: string[] = ['y', 'h', 'v']) {
  it(`parses ${flags.map((f) => `-${f}`).join(' / ')} as booleans`, () => {
    for (const f of flags) {
      expect(parseFlags([`-${f}`], SPEC).values[f]).toBe(true);
    }
  });
}

/** Positional env and the `-env <name>` scripting alternative both seed. */
export function itParsesEnvSeed(SPEC: Spec) {
  it('parses positional env', () => {
    const r = parseFlags(['prod'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.positional.env).toBe('prod');
  });

  it('parses -env <name> as the alternative env seed', () => {
    const r = parseFlags(['-env', 'staging'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values.env).toBe('staging');
  });
}

/**
 * Vibecarbon is single-dash-only: every listed `--long` form (optionally
 * followed by a value, space-separated) must be rejected as unknown.
 */
export function itRejectsDoubleDash(SPEC: Spec, forms: string[]) {
  it('rejects double-dash long forms (no POSIX --long support)', () => {
    for (const form of forms) {
      const argv = form.split(' ');
      expect(parseFlags(argv, SPEC).errors[0]).toMatch(`unknown flag: ${argv[0]}`);
    }
  });
}
