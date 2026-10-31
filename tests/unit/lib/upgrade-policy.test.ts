/**
 * Unit tests for lib/upgrade-policy.js — the pure classifier that decides
 * which template files `vibecarbon upgrade` may auto-replace (safe), must
 * hand to the operator (merge), or must never touch (never). A wrong 'safe'
 * here silently overwrites user code, so the category rules get pinned.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getFilePolicy, getUpgradeableFiles } from '../../../src/lib/upgrade-policy.js';

describe('getFilePolicy', () => {
  it('classifies infra files as safe', () => {
    expect(getFilePolicy('Dockerfile')).toBe('safe');
    expect(getFilePolicy('docker-compose.prod.yml')).toBe('safe');
    expect(getFilePolicy('k8s/base/kustomization.yaml')).toBe('safe');
    // The Garage config the dev override mounts: missing, Docker mounts a directory.
    expect(getFilePolicy('volumes/s3/garage.toml')).toBe('safe');
    expect(getFilePolicy('k8s/base/deep/nested/file.yaml')).toBe('safe');
    expect(getFilePolicy('.github/workflows/deploy.yml')).toBe('safe');
    expect(getFilePolicy('cloud-init/docker-ce-setup.yaml')).toBe('safe');
    // The compose db entrypoint docker-compose.yml mounts: missing, the db
    // container gets a directory there and never starts. The rest of
    // volumes/db stays never.
    expect(getFilePolicy('volumes/db/db-guard.sh')).toBe('safe');
    // compose-backup.sh sources walg-env.sh and the archive_command is
    // wal-archive.sh: stranded, an upgraded project backs up nothing.
    expect(getFilePolicy('volumes/db/walg-env.sh')).toBe('safe');
    expect(getFilePolicy('volumes/db/wal-archive.sh')).toBe('safe');
  });

  it('classifies user-blended files as merge', () => {
    expect(getFilePolicy('docker-compose.yml')).toBe('merge');
    expect(getFilePolicy('package.json')).toBe('merge');
    expect(getFilePolicy('vite.config.ts')).toBe('merge');
    expect(getFilePolicy('k8s/overlays/prod/patch.yaml')).toBe('merge');
  });

  it('classifies user code and data as never', () => {
    expect(getFilePolicy('src/index.ts')).toBe('never');
    expect(getFilePolicy('src/deep/nested/component.tsx')).toBe('never');
    expect(getFilePolicy('.env')).toBe('never');
    expect(getFilePolicy('pnpm-lock.yaml')).toBe('never');
    expect(getFilePolicy('volumes/db/data.sql')).toBe('never');
    expect(getFilePolicy('README.md')).toBe('never');
  });

  // After create, db/migrations is the project's own history (the app
  // applies it at startup, ledger in drizzle.__drizzle_migrations). An
  // upgrade that rewrote or added a migration would change what an applied
  // ledger means, or replay the template's baseline over a live schema.
  it('never touches db/migrations, the SQL or drizzle meta', () => {
    for (const f of [
      'db/migrations/0000_baseline_pre.sql',
      'db/migrations/0001_baseline_schema.sql',
      'db/migrations/0007_add_projects.sql',
      'db/migrations/meta/_journal.json',
      'db/migrations/meta/0001_snapshot.json',
    ]) {
      expect(getFilePolicy(f), f).toBe('never');
    }
  });

  it('never ships the template-only migrations census or tests at all', () => {
    expect(getFilePolicy('tests/structural/template-migrations-census.test.ts')).toBe('never');
  });

  it('defaults unclassified paths to never', () => {
    expect(getFilePolicy('some-random-file.txt')).toBe('never');
    expect(getFilePolicy('docs/notes.md')).toBe('never');
  });

  it('does not let a ** pattern match its bare directory prefix', () => {
    // 'k8s/base/**' requires a path segment under k8s/base/.
    expect(getFilePolicy('k8s/base')).toBe('never');
    expect(getFilePolicy('k8s/basefoo/x.yaml')).toBe('never');
  });
});

describe('getUpgradeableFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-upgrade-policy-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only safe + merge files, skipping node_modules and .git', () => {
    const files = [
      'Dockerfile', // safe
      'package.json', // merge
      'k8s/base/kustomization.yaml', // safe
      'src/app.ts', // never
      'README.md', // never
      'node_modules/pkg/index.js', // dir skipped entirely
      '.git/HEAD', // dir skipped entirely
    ];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'x');
    }

    const upgradeable = getUpgradeableFiles(dir).sort();
    expect(upgradeable).toEqual(['Dockerfile', 'k8s/base/kustomization.yaml', 'package.json']);
  });

  it('returns an empty list for an unreadable root', () => {
    expect(getUpgradeableFiles(join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('needs-review conflict prompts default to replace', () => {
  // 2026-07-16 (Brandon): enter-through must APPLY the upgrade (with a
  // .upgrade-backup escape hatch), not strand improvements in .upgrade-new
  // files nobody renames. Pins BOTH selects (initial prompt + post-diff
  // re-prompt) in src/upgrade.js.
  it("every conflict select in upgrade.js uses initialValue: 'replace'", () => {
    const src = readFileSync(join(__dirname, '../../../src/upgrade.js'), 'utf-8');
    const defaults = [...src.matchAll(/initialValue: '(\w+)'/g)].map((m) => m[1]);
    expect(defaults.length).toBeGreaterThanOrEqual(2);
    expect(new Set(defaults)).toEqual(new Set(['replace']));
  });
});
