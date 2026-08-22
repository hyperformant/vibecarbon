import { describe, expect, it } from 'vitest';
import { SPEC } from '../../../src/destroy.js';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import {
  itParsesBooleanFlags,
  itParsesEnvSeed,
  itRejectsDoubleDash,
} from '../../_shared/arg-parser-suite.js';

describe('destroy SPEC + parseFlags integration', () => {
  it('returns sane defaults when no args are supplied', () => {
    const r = parseFlags([], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({
      h: false,
      v: false,
      y: false,
      env: null,
      orphans: false,
      purge: false,
    });
    expect(r.positional.env).toBeUndefined();
  });

  itParsesEnvSeed(SPEC);
  itParsesBooleanFlags(SPEC);

  it('parses -orphans (replaces --destroy-orphans)', () => {
    expect(parseFlags(['-orphans'], SPEC).values.orphans).toBe(true);
    // -y alone does NOT enable orphan destruction (PR 1S blast-radius guard).
    expect(parseFlags(['-y'], SPEC).values.orphans).toBe(false);
  });

  it('parses -purge (replaces --purge-backups)', () => {
    expect(parseFlags(['-purge'], SPEC).values.purge).toBe(true);
    expect(parseFlags(['-y'], SPEC).values.purge).toBe(false);
  });

  it('handles multiple flags together', () => {
    const r = parseFlags(['prod', '-y', '-purge'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.positional.env).toBe('prod');
    expect(r.values.y).toBe(true);
    expect(r.values.purge).toBe(true);
  });

  it('handles environment names with special characters', () => {
    expect(parseFlags(['-env', 'feature-branch'], SPEC).values.env).toBe('feature-branch');
    expect(parseFlags(['-env', 'test_env'], SPEC).values.env).toBe('test_env');
  });

  itRejectsDoubleDash(SPEC, ['--env prod', '--destroy-orphans', '--purge-backups', '--help']);

  it('rejects -e (the old --env short form is gone — use -env instead)', () => {
    expect(parseFlags(['-e', 'prod'], SPEC).errors[0]).toMatch(/unknown flag: -e/);
  });
});
