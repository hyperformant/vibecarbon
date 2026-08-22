import { describe, expect, it } from 'vitest';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import { SPEC } from '../../../src/status.js';
import { itParsesBooleanFlags, itRejectsDoubleDash } from '../../_shared/arg-parser-suite.js';

// Status now uses the shared single-dash parser. These tests pin the
// surviving flag surface (no -e alias, no --no-local, no --long forms)
// and confirm parseFlags + SPEC produce the right shape.

describe('status flag parsing', () => {
  it('parses -env <name>', () => {
    const r = parseFlags(['-env', 'prod'], SPEC);
    expect(r.values.env).toBe('prod');
    expect(r.errors).toEqual([]);
  });

  it('parses -json', () => {
    const r = parseFlags(['-json'], SPEC);
    expect(r.values.json).toBe(true);
    expect(r.errors).toEqual([]);
  });

  itParsesBooleanFlags(SPEC, ['h', 'v']);
  itRejectsDoubleDash(SPEC, ['--env prod']);

  it('rejects -e (single-letter shorthand was dropped — use -env)', () => {
    const r = parseFlags(['-e', 'prod'], SPEC);
    expect(r.errors[0]).toMatch(/unknown flag/);
  });

  it('rejects -no-local (now context-sensitive on JSON / non-TTY)', () => {
    const r = parseFlags(['-no-local'], SPEC);
    expect(r.errors[0]).toMatch(/unknown flag/);
  });

  it('handles multiple flags together', () => {
    const r = parseFlags(['-env', 'prod', '-json'], SPEC);
    expect(r.values.env).toBe('prod');
    expect(r.values.json).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('defaults are null/false', () => {
    const r = parseFlags([], SPEC);
    expect(r.values.env).toBeNull();
    expect(r.values.json).toBe(false);
    expect(r.values.h).toBe(false);
    expect(r.values.v).toBe(false);
  });

  it('preserves env values with special characters', () => {
    expect(parseFlags(['-env', 'feature-branch'], SPEC).values.env).toBe('feature-branch');
    expect(parseFlags(['-env', 'test_env'], SPEC).values.env).toBe('test_env');
  });
});
