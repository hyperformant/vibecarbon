import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFlags, parseFlagsOrExit } from '../../../../src/lib/cli/parse-flags.js';

describe('parseFlags', () => {
  describe('boolean flags', () => {
    it('defaults to false when not present', () => {
      const r = parseFlags([], {
        name: 'x',
        flags: [{ name: 'l', boolean: true }],
      });
      expect(r.values.l).toBe(false);
      expect(r.errors).toEqual([]);
    });

    it('flips to true when present', () => {
      const r = parseFlags(['-l'], {
        name: 'x',
        flags: [{ name: 'l', boolean: true }],
      });
      expect(r.values.l).toBe(true);
    });

    it('handles multiple boolean flags in any order', () => {
      const r = parseFlags(['-y', '-l', '-h'], {
        name: 'x',
        flags: [
          { name: 'h', boolean: true },
          { name: 'y', boolean: true },
          { name: 'l', boolean: true },
        ],
      });
      expect(r.values).toEqual({ h: true, y: true, l: true });
      expect(r.errors).toEqual([]);
    });
  });

  describe('value flags', () => {
    it('captures the next argv element as the value', () => {
      const r = parseFlags(['-env', 'prod'], {
        name: 'x',
        flags: [{ name: 'env', value: '<name>' }],
      });
      expect(r.values.env).toBe('prod');
      expect(r.errors).toEqual([]);
    });

    it('errors when the value is missing', () => {
      const r = parseFlags(['-env'], {
        name: 'x',
        flags: [{ name: 'env', value: '<name>' }],
      });
      expect(r.values.env).toBeNull();
      expect(r.errors).toEqual(['flag -env requires a value']);
    });

    it('errors when the next argv element is itself a flag (almost certainly a forgotten value)', () => {
      const r = parseFlags(['-env', '-y'], {
        name: 'x',
        flags: [
          { name: 'env', value: '<name>' },
          { name: 'y', boolean: true },
        ],
      });
      expect(r.values.env).toBeNull();
      expect(r.errors).toEqual(['flag -env requires a value']);
      // -y should still be parsed in the next iteration.
      expect(r.values.y).toBe(true);
    });

    it('rejects values outside the declared enum', () => {
      const r = parseFlags(['-mode', 'fictional'], {
        name: 'x',
        flags: [{ name: 'mode', value: '<m>', enum: ['compose', 'k8s'] }],
      });
      expect(r.values.mode).toBeNull();
      expect(r.errors).toEqual(['-mode must be one of: compose, k8s (got: fictional)']);
    });

    it('accepts enum values', () => {
      const r = parseFlags(['-mode', 'k8s'], {
        name: 'x',
        flags: [{ name: 'mode', value: '<m>', enum: ['compose', 'k8s'] }],
      });
      expect(r.values.mode).toBe('k8s');
      expect(r.errors).toEqual([]);
    });
  });

  describe('positional arguments', () => {
    it('captures a single positional', () => {
      const r = parseFlags(['prod'], {
        name: 'x',
        positional: [{ name: 'env', optional: true }],
      });
      expect(r.positional.env).toBe('prod');
    });

    it('errors on missing required positional', () => {
      const r = parseFlags([], {
        name: 'x',
        positional: [{ name: 'feature' }],
      });
      expect(r.errors).toEqual(['missing required argument: feature']);
    });

    it('omits optional positional silently when missing', () => {
      const r = parseFlags([], {
        name: 'x',
        positional: [{ name: 'env', optional: true }],
      });
      expect(r.positional.env).toBeUndefined();
      expect(r.errors).toEqual([]);
    });

    it('collects variadic into an array', () => {
      const r = parseFlags(['n8n', 'redis', 'metabase'], {
        name: 'x',
        positional: [{ name: 'features', variadic: true, optional: true }],
      });
      expect(r.positional.features).toEqual(['n8n', 'redis', 'metabase']);
    });

    it('errors on excess positionals when no variadic is declared', () => {
      const r = parseFlags(['prod', 'extra'], {
        name: 'x',
        positional: [{ name: 'env', optional: true }],
      });
      expect(r.positional.env).toBe('prod');
      expect(r.errors).toEqual(['unexpected argument: extra']);
    });
  });

  describe('mixed flags + positionals', () => {
    it('flag-then-positional', () => {
      const r = parseFlags(['-l', 'prod'], {
        name: 'x',
        flags: [{ name: 'l', boolean: true }],
        positional: [{ name: 'env', optional: true }],
      });
      expect(r.values.l).toBe(true);
      expect(r.positional.env).toBe('prod');
    });

    it('positional-then-flag', () => {
      const r = parseFlags(['prod', '-l'], {
        name: 'x',
        flags: [{ name: 'l', boolean: true }],
        positional: [{ name: 'env', optional: true }],
      });
      expect(r.values.l).toBe(true);
      expect(r.positional.env).toBe('prod');
    });

    it('value-flag interleaved with positional', () => {
      const r = parseFlags(['prod', '-env', 'staging', '-l'], {
        name: 'x',
        flags: [
          { name: 'env', value: '<name>' },
          { name: 'l', boolean: true },
        ],
        positional: [{ name: 'env', optional: true }],
      });
      // Positional and -env flag have the same name in different
      // namespaces; positional is `prod`, flag is `staging`.
      expect(r.positional.env).toBe('prod');
      expect(r.values.env).toBe('staging');
      expect(r.values.l).toBe(true);
    });
  });

  describe('rejection cases', () => {
    it('rejects unknown single-dash flags', () => {
      const r = parseFlags(['-bogus'], {
        name: 'x',
        flags: [{ name: 'l', boolean: true }],
      });
      expect(r.errors).toEqual(['unknown flag: -bogus']);
    });

    it('rejects double-dash flags as unknown (no POSIX long form supported)', () => {
      const r = parseFlags(['--help'], {
        name: 'x',
        flags: [{ name: 'h', boolean: true }],
      });
      expect(r.errors).toEqual(['unknown flag: --help']);
      // -h still works in single-dash form.
      const ok = parseFlags(['-h'], {
        name: 'x',
        flags: [{ name: 'h', boolean: true }],
      });
      expect(ok.values.h).toBe(true);
      expect(ok.errors).toEqual([]);
    });

    it('rejects bare `-` as unknown', () => {
      const r = parseFlags(['-'], { name: 'x', flags: [] });
      expect(r.errors).toEqual(['unknown flag: -']);
    });
  });

  describe('schema validation', () => {
    it('throws when a flag spec sets both boolean and value', () => {
      expect(() =>
        parseFlags([], {
          name: 'x',
          flags: [{ name: 'env', boolean: true, value: '<name>' }],
        }),
      ).toThrow(/both `boolean` and `value`/);
    });

    it('throws when a variadic positional is not last', () => {
      expect(() =>
        parseFlags(['a', 'b'], {
          name: 'x',
          positional: [
            { name: 'rest', variadic: true, optional: true },
            { name: 'env', optional: true },
          ],
        }),
      ).toThrow(/variadic but not the last/);
    });
  });
});

describe('parseFlagsOrExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression (2026-07-16): `vibecarbon console -h` exited(1) with
  // "missing required argument: node" — and hinted at `console -h` — because
  // the error branch ran before the -h branch. Asking for help must never
  // require valid arguments.
  it('-h renders help even when a required positional is missing', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });

    const spec = {
      name: 'console',
      flags: [{ name: 'h', boolean: true, description: 'Show this help' }],
      positional: [{ name: 'node' }],
    };
    const { handled } = parseFlagsOrExit(['-h'], spec);

    expect(handled).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(out.mock.calls.map((c) => c[0]).join('')).toContain('console');
  });

  it('parse errors still exit(1) when -h is absent', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });

    const spec = { name: 'console', positional: [{ name: 'node' }] };
    expect(() => parseFlagsOrExit([], spec)).toThrow('exit called');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.map((c) => c[0]).join('')).toContain('missing required argument: node');
  });
});
