import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertConfigUnchanged,
  diffConfigSnapshots,
  parseConfigList,
} from '../../_shared/git-config-guard.js';
import { createGuard as guardSetup } from '../../setup/git-config-guard.js';

const list = (...records: string[]) => `${records.join('\0')}\0`;

describe('git config guard comparison', () => {
  const base = parseConfigList(
    list(
      'core.bare\nfalse',
      'remote.origin.url\ngit@example.test:o/r.git',
      'branch.main.remote\norigin',
    ),
  );

  it('an unchanged config passes', () => {
    expect(() => assertConfigUnchanged(base, new Map(base))).not.toThrow();
  });

  it('a changed value fails, naming the key', () => {
    const after = parseConfigList(
      list('core.bare\ntrue', 'remote.origin.url\ngit@example.test:o/r.git'),
    );
    expect(() => assertConfigUnchanged(base, after)).toThrow(
      /core\.bare: \["false"\] -> \["true"\]/,
    );
  });

  it('an added key fails, naming the key (the identity incident)', () => {
    const after = parseConfigList(
      list(
        'core.bare\nfalse',
        'remote.origin.url\ngit@example.test:o/r.git',
        'user.name\nT',
        'user.email\nt@example.test',
      ),
    );
    const err = (() => {
      try {
        assertConfigUnchanged(base, after);
      } catch (e) {
        return String(e);
      }
      return '';
    })();
    expect(err).toContain('user.name: (unset) -> ["T"]');
    expect(err).toContain('user.email: (unset) -> ["t@example.test"]');
    expect(err).not.toContain('core.bare');
  });

  it('a removed key fails', () => {
    const after = parseConfigList(list('core.bare\nfalse'));
    expect(diffConfigSnapshots(base, after)).toEqual([
      'remote.origin.url: ["git@example.test:o/r.git"] -> (unset)',
    ]);
  });

  it('a second value of a multi-valued key counts', () => {
    const after = parseConfigList(
      list(
        'core.bare\nfalse',
        'remote.origin.url\ngit@example.test:o/r.git',
        'remote.origin.url\nhttps://evil.test/r.git',
      ),
    );
    expect(diffConfigSnapshots(base, after)).toHaveLength(1);
  });

  it('fails worded as a change during the run, with the key and both values', () => {
    const after = parseConfigList(
      list('core.bare\ntrue', 'remote.origin.url\ngit@example.test:o/r.git'),
    );
    const err = (() => {
      try {
        assertConfigUnchanged(base, after);
      } catch (e) {
        return String(e);
      }
      return '';
    })();
    expect(err).toContain('changed during the run:\n  core.bare: ["false"] -> ["true"]');
    // Another session in the shared checkout is a writer too: the suite is
    // not blamed outright.
    expect(err).toContain('another session working in this checkout');
    expect(err).not.toContain('—');
  });

  it.each([
    ['core.hooksPath', 'core.hooksPath\n/tmp/hooks'],
    ['user.signingkey', 'user.signingkey\nABC123'],
    ['a second remote url', 'remote.fork.url\ngit@example.test:f/r.git'],
  ])('%s added counts', (_, record) => {
    const after = parseConfigList(
      list('core.bare\nfalse', 'remote.origin.url\ngit@example.test:o/r.git', record),
    );
    expect(diffConfigSnapshots(base, after)).toHaveLength(1);
  });

  // Keys other tools write while a suite runs, often from another session in
  // another worktree. None changes who commits, where pushes go, or bareness.
  it.each([
    ['gh repo set-default', 'remote.origin.gh-resolved\nbase'],
    ['git maintenance start', 'maintenance.auto\nfalse'],
    ['git maintenance start (strategy)', 'maintenance.strategy\nincremental'],
    ['a remote fetch refspec', 'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*'],
  ])('%s is not a change', (_, record) => {
    const after = parseConfigList(
      list('core.bare\nfalse', 'remote.origin.url\ngit@example.test:o/r.git', record),
    );
    expect(diffConfigSnapshots(base, after)).toEqual([]);
  });

  it('branch.* churn (git push -u in another worktree) is not a change', () => {
    const after = parseConfigList(
      list(
        'core.bare\nfalse',
        'remote.origin.url\ngit@example.test:o/r.git',
        'branch.other.remote\norigin',
      ),
    );
    expect(diffConfigSnapshots(base, after)).toEqual([]);
  });
});

describe('the global setup teardown', () => {
  const quiet = () => parseConfigList(list('core.bare\nfalse'));
  const tampered = () => parseConfigList(list('core.bare\ntrue'));
  let savedExit: typeof process.exitCode;
  beforeEach(() => {
    savedExit = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExit;
  });

  const run = (after: () => Map<string, string[]>) => {
    const seq = [quiet, after];
    const teardown = guardSetup(() => (seq.shift() as () => Map<string, string[]>)());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    (teardown as () => void)();
    return err.mock.calls.flat().join('\n');
  };

  it('a differing snapshot prints the changed key and sets exit code 1', () => {
    const printed = run(tampered);
    expect(printed).toContain('core.bare: ["false"] -> ["true"]');
    expect(process.exitCode).toBe(1);
  });

  it('an identical snapshot prints nothing and leaves the exit code alone', () => {
    const printed = run(quiet);
    expect(printed).toBe('');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('every vitest project runs the guard', () => {
  const config = readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf-8');

  it('the root config lists it and every project extends the root', () => {
    expect(config).toMatch(/^ {4}globalSetup: \['tests\/setup\/git-config-guard\.ts'\]/m);
    // vitest merges a project's own globalSetup into the root's (checked by
    // hand against 5.1.0, unit/integration/integration-docker), so extending
    // the root is what puts the guard in front of every project.
    const projects = [...config.matchAll(/^ {10}name: '([\w-]+)'/gm)].map((m) => m[1]);
    const extending = [...config.matchAll(/^ {8}extends: true,/gm)];
    expect(projects.length).toBeGreaterThanOrEqual(4);
    expect(extending).toHaveLength(projects.length);
  });
});
