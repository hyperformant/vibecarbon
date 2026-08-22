import { describe, expect, it } from 'vitest';
import { SPEC } from '../../../src/create.js';
import { parseFlags } from '../../../src/lib/cli/parse-flags.js';
import { itParsesBooleanFlags, itRejectsDoubleDash } from '../../_shared/arg-parser-suite.js';

describe('create SPEC + parseFlags integration', () => {
  it('returns sane defaults when no args are supplied', () => {
    const r = parseFlags([], SPEC);
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({
      h: false,
      v: false,
      y: false,
      install: false,
      pm: null,
      'admin-email': null,
      'admin-password': null,
    });
    expect(r.positional.projectName).toBeUndefined();
  });

  it('parses positional project name', () => {
    expect(parseFlags(['my-app'], SPEC).positional.projectName).toBe('my-app');
  });

  itParsesBooleanFlags(SPEC);

  it('parses -install (opt-in to running pm install during create)', () => {
    expect(parseFlags(['-install'], SPEC).values.install).toBe(true);
  });

  it('parses -skip-lockfile (opt-out of lockfile generation)', () => {
    expect(parseFlags([], SPEC).values['skip-lockfile']).toBe(false);
    expect(parseFlags(['-skip-lockfile'], SPEC).values['skip-lockfile']).toBe(true);
  });

  it('parses -pm <enum> against npm/pnpm/bun', () => {
    expect(parseFlags(['-pm', 'npm'], SPEC).values.pm).toBe('npm');
    expect(parseFlags(['-pm', 'pnpm'], SPEC).values.pm).toBe('pnpm');
    expect(parseFlags(['-pm', 'bun'], SPEC).values.pm).toBe('bun');
  });

  it('rejects -pm values outside the enum (e.g. yarn)', () => {
    const r = parseFlags(['-pm', 'yarn'], SPEC);
    expect(r.values.pm).toBeNull();
    expect(r.errors[0]).toMatch(/-pm must be one of: npm, pnpm, bun/);
  });

  it('parses -admin-email and -admin-password (space-separated, not =)', () => {
    expect(parseFlags(['-admin-email', 'admin@example.com'], SPEC).values['admin-email']).toBe(
      'admin@example.com',
    );
    expect(parseFlags(['-admin-password', 'secret'], SPEC).values['admin-password']).toBe('secret');
  });

  it('handles multiple flags together (scripted CI invocation)', () => {
    const r = parseFlags(
      [
        'my-app',
        '-y',
        '-install',
        '-pm',
        'pnpm',
        '-admin-email',
        'admin@example.com',
        '-admin-password',
        'secret',
      ],
      SPEC,
    );
    expect(r.errors).toEqual([]);
    expect(r.positional.projectName).toBe('my-app');
    expect(r.values.y).toBe(true);
    expect(r.values.install).toBe(true);
    expect(r.values.pm).toBe('pnpm');
    expect(r.values['admin-email']).toBe('admin@example.com');
    expect(r.values['admin-password']).toBe('secret');
  });

  itRejectsDoubleDash(SPEC, ['--yes', '--git', '--use-npm', '--admin-email=admin@x.com']);

  it('rejects --use-npm / --use-pnpm / --use-bun (collapsed into -pm)', () => {
    for (const dropped of ['--use-npm', '--use-pnpm', '--use-bun', '--use-yarn']) {
      expect(parseFlags([dropped], SPEC).errors).toEqual([`unknown flag: ${dropped}`]);
    }
  });

  it('rejects --no-git (git init is unconditional; there is no -git or -no-git flag)', () => {
    expect(parseFlags(['--no-git'], SPEC).errors).toEqual(['unknown flag: --no-git']);
  });
});
