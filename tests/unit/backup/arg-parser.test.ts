import { describe, expect, it } from 'vitest';
import { SPEC } from '../../../src/backup.js';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import {
  itParsesBooleanFlags,
  itParsesEnvSeed,
  itRejectsDoubleDash,
} from '../../_shared/arg-parser-suite.js';

describe('backup SPEC + parseFlags integration', () => {
  it('returns sane defaults when no args are supplied', () => {
    const r = parseFlags([], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({
      h: false,
      v: false,
      y: false,
      l: false,
      env: null,
      action: null,
      source: null,
    });
    expect(r.positional.env).toBeUndefined();
  });

  it('parses -l (list shortcut)', () => {
    const r = parseFlags(['-l'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values.l).toBe(true);
  });

  itParsesBooleanFlags(SPEC);
  itParsesEnvSeed(SPEC);

  it('parses -action <verb> against the declared enum', () => {
    expect(parseFlags(['-action', 'create'], SPEC).values.action).toBe('create');
    expect(parseFlags(['-action', 'list'], SPEC).values.action).toBe('list');
    expect(parseFlags(['-action', 'download'], SPEC).values.action).toBe('download');
  });

  it('rejects -action values outside the enum', () => {
    const r = parseFlags(['-action', 'nuke'], SPEC);
    expect(r.values.action).toBeNull();
    expect(r.errors[0]).toMatch(/-action.*create.*list.*download.*nuke/);
  });

  it('parses -source <name>', () => {
    const r = parseFlags(['-source', 'myapp_2026.tar.gz'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values.source).toBe('myapp_2026.tar.gz');
  });

  it('combines positional + flags', () => {
    const r = parseFlags(['prod', '-l', '-y'], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.positional.env).toBe('prod');
    expect(r.values.l).toBe(true);
    expect(r.values.y).toBe(true);
  });

  it('parses scripted-download invocation end-to-end', () => {
    const r = parseFlags(
      ['-env', 'prod', '-action', 'download', '-source', 'myapp_2026.tar.gz', '-y'],
      SPEC,
    );
    expect(r.errors).toEqual([]);
    expect(r.values.env).toBe('prod');
    expect(r.values.action).toBe('download');
    expect(r.values.source).toBe('myapp_2026.tar.gz');
    expect(r.values.y).toBe(true);
  });

  itRejectsDoubleDash(SPEC, ['--list', '--help', '--download x.tar.gz']);

  it('rejects -d (the old --download short form is gone)', () => {
    const r = parseFlags(['-d', 'x.tar.gz'], SPEC);
    expect(r.errors[0]).toMatch(/unknown flag: -d/);
  });
});
