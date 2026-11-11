import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertConfigUnchanged,
  diffConfigSnapshots,
  parseConfigList,
} from '../../_shared/git-config-guard.js';
import guardSetup from '../../setup/git-config-guard.js';

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

  it('the real setup takes a snapshot and its teardown passes on an untouched config', () => {
    const teardown = guardSetup();
    expect(typeof teardown).toBe('function');
    // Another worktree may legitimately touch non-branch keys in this window
    // (git remote add); only the pass path on a quiet config is asserted here.
    expect(() => (teardown as () => void)()).not.toThrow();
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
