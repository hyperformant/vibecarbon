import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateBackupFilename } from '../../../src/lib/validators.js';

describe('C-4: backup filename validation rejects injection payloads', () => {
  it.each([
    ['x;rm -rf /;#.tar.gz'],
    ['$(whoami).tar.gz'],
    ['`id`.tar.gz'],
    ['"; cat /etc/passwd; "'],
    ['../../etc/passwd'],
    ['/abs/path.tar.gz'],
    ['foo/bar.tar.gz'],
    ['backup.zip'], // wrong extension
    [''],
  ])('rejects %s', (payload) => {
    expect(validateBackupFilename(payload)).toBeTruthy();
  });

  it.each([['vibecarbon-20260417.tar.gz'], ['dump.sql.gz'], ['backup_2026_01_01.tar']])(
    'accepts canonical filename %s',
    (good) => {
      expect(validateBackupFilename(good)).toBeUndefined();
    },
  );
});

describe('C-4: restore.js uses tar safety flags', () => {
  // GNU tar strips leading `/` by default — the unsafe opt-in is `-P` /
  // `--absolute-names`. Assert that opt-in is NEVER present and that the
  // valid `--no-xattrs --no-same-owner` hardening flags ARE present.
  // (An earlier iteration required `--no-absolute-names`, which is not a
  // real GNU tar option and fails at extraction time.)

  it('restore.js tar invocations include --no-xattrs and --no-same-owner, never --absolute-names', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'restore.js'), 'utf-8');
    const tarInvocations = src.match(/tar[\s\S]{0,200}(xzf|-xzf)/g) || [];
    for (const inv of tarInvocations) {
      expect(inv).toContain('--no-xattrs');
      expect(inv).toContain('--no-same-owner');
      expect(inv).not.toMatch(/--absolute-names\b/);
      expect(inv).not.toMatch(/(^|\s)-[A-Za-np-zA-Z]*P[A-Za-np-zA-Z]*(\s|$)/);
    }
  });

  it('restore.js uses argv-form sshRun for tar extraction of untrusted remotePath', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'restore.js'), 'utf-8');
    // The primary extraction (line ~165) must use sshRun with argv form.
    // Check that the old sshExec string-form tar call is gone.
    expect(src).not.toMatch(/sshExec\([^)]+`[^`]*tar\s+xzf\s+\$\{remotePath\}/);
  });

  it('compose/index.js tar invocations include --no-xattrs and --no-same-owner, never --absolute-names', async () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'lib', 'deploy', 'compose', 'index.js'),
      'utf-8',
    );
    const tarInvocations = src.match(/tar[\s\S]{0,200}(xzf|-xzf)/g) || [];
    expect(tarInvocations.length).toBeGreaterThan(0);
    for (const inv of tarInvocations) {
      expect(inv).toContain('--no-xattrs');
      expect(inv).toContain('--no-same-owner');
      expect(inv).not.toMatch(/--absolute-names\b/);
      expect(inv).not.toMatch(/(^|\s)-[A-Za-np-zA-Z]*P[A-Za-np-zA-Z]*(\s|$)/);
    }
  });
});
