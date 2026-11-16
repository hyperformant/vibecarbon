import { describe, expect, it } from 'vitest';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import { SPEC } from '../../../src/update.js';
import {
  itParsesBooleanFlags,
  itParsesEnvSeed,
  itRejectsDoubleDash,
} from '../../_shared/arg-parser-suite.js';

describe('update SPEC + parseFlags', () => {
  it('returns sane defaults when no args are supplied', () => {
    const r = parseFlags([], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({ h: false, v: false, y: false, json: false, env: null });
    expect(r.positional.env).toBeUndefined();
  });

  itParsesBooleanFlags(SPEC, ['y', 'h', 'v', 'json']);
  itParsesEnvSeed(SPEC);
  itRejectsDoubleDash(SPEC, ['--yes', '--json']);

  it('has the registry summary', () => {
    expect(SPEC.summary).toBe('Install system updates and restart servers when needed');
  });

  it('points at upgrade in its description', () => {
    expect(SPEC.description.split('\n').at(-1)).toBe(
      "Looking for vibecarbon upgrade? That one updates your project's infrastructure files from the template.",
    );
  });
});
