import { describe, expect, it } from 'vitest';
import { SPEC } from '../../../src/failover.js';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import {
  itParsesBooleanFlags,
  itParsesEnvSeed,
  itRejectsDoubleDash,
} from '../../_shared/arg-parser-suite.js';

describe('failover SPEC + parseFlags integration', () => {
  it('returns sane defaults when no args are supplied', () => {
    const r = parseFlags([], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({
      h: false,
      v: false,
      y: false,
      dry: false,
      env: null,
      'server-type': null,
    });
    expect(r.positional.env).toBeUndefined();
  });

  it('parses -dry (replaces -dry-run / -n)', () => {
    expect(parseFlags(['-dry'], SPEC).values.dry).toBe(true);
  });

  it('parses -server-type <id> as a value flag (pilot-light worker override)', () => {
    const r = parseFlags(['-server-type', 'cpx41'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values['server-type']).toBe('cpx41');
  });

  it('rejects -server-type with no value', () => {
    expect(parseFlags(['-server-type'], SPEC).errors[0]).toMatch(
      /flag -server-type requires a value/,
    );
  });

  itParsesEnvSeed(SPEC);
  itParsesBooleanFlags(SPEC);

  it('handles combined flags + positional in any order', () => {
    const r = parseFlags(['-dry', 'prod', '-y'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.positional.env).toBe('prod');
    expect(r.values.dry).toBe(true);
    expect(r.values.y).toBe(true);
  });

  itRejectsDoubleDash(SPEC, ['--dry-run', '--help', '--yes']);

  it('rejects -n (the old -dry-run short form is gone)', () => {
    expect(parseFlags(['-n'], SPEC).errors[0]).toMatch(/unknown flag: -n/);
  });
});
