import { describe, expect, it } from 'vitest';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import { SPEC } from '../../../src/restore.js';
import {
  itParsesBooleanFlags,
  itParsesEnvSeed,
  itRejectsDoubleDash,
} from '../../_shared/arg-parser-suite.js';

describe('restore SPEC + parseFlags integration', () => {
  it('returns sane defaults when no args are supplied', () => {
    const r = parseFlags([], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({
      h: false,
      v: false,
      y: false,
      l: false,
      env: null,
      source: null,
    });
    expect(r.positional.env).toBeUndefined();
  });

  it('parses -l (list shortcut — new in this rewrite)', () => {
    const r = parseFlags(['-l'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values.l).toBe(true);
  });

  itParsesBooleanFlags(SPEC);
  itParsesEnvSeed(SPEC);

  it('parses -source <file-or-name>', () => {
    expect(parseFlags(['-source', 'myapp_2026.tar.gz'], SPEC).values.source).toBe(
      'myapp_2026.tar.gz',
    );
    expect(parseFlags(['-source', './backup.tar.gz'], SPEC).values.source).toBe('./backup.tar.gz');
  });

  it('combines positional + flags', () => {
    const r = parseFlags(['prod', '-l', '-y'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.positional.env).toBe('prod');
    expect(r.values.l).toBe(true);
    expect(r.values.y).toBe(true);
  });

  it('parses scripted invocation end-to-end', () => {
    const r = parseFlags(['-env', 'prod', '-source', './backup.tar.gz', '-y'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values.env).toBe('prod');
    expect(r.values.source).toBe('./backup.tar.gz');
    expect(r.values.y).toBe(true);
  });

  itRejectsDoubleDash(SPEC, ['--list', '--help', '--from-s3 x.tar.gz', '--file ./x.tar.gz']);

  it('rejects -f and -file as unknown (the old --file / -f forms are gone)', () => {
    expect(parseFlags(['-f', 'x.tar.gz'], SPEC).errors[0]).toMatch(/unknown flag: -f/);
  });
});
