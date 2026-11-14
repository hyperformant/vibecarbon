/**
 * The CLI's own edits to template files after create (src/lib/template-edits.js):
 * configure's GitHub owner/repo rewrite and add's k8s/base entries. upgrade
 * undoes them before comparing with a stored checksum and makes them again on
 * what it writes, so both directions have to be exact.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CICD_WORKFLOW_FILES } from '../../../src/lib/ci-setup.js';
import { gitSafeEnv } from '../../../src/lib/command.js';
import {
  addKustomizationEntry,
  BASE_KUSTOMIZATION,
  GITHUB_REF_FILES,
  originGitHubRepo,
  recordedGitHubRepo,
  removeKustomizationEntry,
  restoreGitHubRefs,
  rewriteGitHubRefs,
  templateEdits,
  writeGitHubRefs,
} from '../../../src/lib/template-edits.js';
import { projectPathFor, templatePathFor } from '../../../src/lib/template-paths.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const ROOT = process.cwd();
const CARBON = join(ROOT, 'carbon');
const PROJECT = 'test-app';
const REFS = { projectName: PROJECT, owner: 'acme', repo: 'shop' };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.git') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** A template file as create lays it down: owner and repo both the project name. */
function created(rel: string): string {
  return readFileSync(join(CARBON, templatePathFor(rel)), 'utf-8')
    .replaceAll('{{GITHUB_OWNER}}', PROJECT)
    .replaceAll('{{PROJECT_NAME}}', PROJECT);
}

describe('GITHUB_REF_FILES is every template file with a GitHub ref', () => {
  const REF = /(ghcr\.io|github\.com)\/\{\{GITHUB_OWNER\}\}\/\{\{PROJECT_NAME\}\}/;

  it('lists every file whose refs create bakes as <project>/<project>, and nothing else', () => {
    const withRefs = walk(CARBON)
      .filter((f) => REF.test(readFileSync(f, 'utf-8')))
      .map((f) => projectPathFor(relative(CARBON, f)))
      .sort();
    expect(withRefs.length).toBeGreaterThan(3);
    expect([...GITHUB_REF_FILES].sort()).toEqual(withRefs);
  });

  it('the workflows configure installs as they are carry no create-time token', () => {
    // configure copies them raw while create and upgrade render the tokens:
    // a token here makes the installed copy differ from upgrade's for good.
    for (const rel of CICD_WORKFLOW_FILES) {
      const text = readFileSync(join(CARBON, rel), 'utf-8');
      expect(text, rel).not.toMatch(
        /\{\{(PROJECT_NAME|PROJECT_DISPLAY_NAME|GITHUB_OWNER|SITE_URL|ADMIN_EMAIL)\}\}/,
      );
    }
  });
});

describe('rewriteGitHubRefs and restoreGitHubRefs', () => {
  for (const rel of GITHUB_REF_FILES) {
    it(`${rel}: the rewrite points every ref at owner/repo, and restore undoes it exactly`, () => {
      const before = created(rel);
      const after = rewriteGitHubRefs(before, REFS);
      expect(after).not.toBe(before);
      expect(after).not.toMatch(/(ghcr\.io|github\.com)\/test-app\/test-app/);
      expect(rewriteGitHubRefs(after, REFS)).toBe(after);
      expect(restoreGitHubRefs(after, REFS)).toBe(before);
    });
  }

  it('keeps suffixes and tags, and never touches a longer repo name or another repo', () => {
    const text = [
      'image: ghcr.io/x/test-app:main',
      'image: ghcr.io/x/test-app-db:17',
      'image: ghcr.io/x/test-app-backup',
      'image: ghcr.io/x/test-app-other:1',
      'url: https://github.com/x/test-app.git',
      'url: https://github.com/x/test-app-other',
      'image: ghcr.io/hyperformant/traefik:3',
      '',
    ].join('\n');
    expect(rewriteGitHubRefs(text, REFS)).toBe(
      [
        'image: ghcr.io/acme/shop:main',
        'image: ghcr.io/acme/shop-db:17',
        'image: ghcr.io/acme/shop-backup',
        'image: ghcr.io/x/test-app-other:1',
        'url: https://github.com/acme/shop.git',
        'url: https://github.com/x/test-app-other',
        'image: ghcr.io/hyperformant/traefik:3',
        '',
      ].join('\n'),
    );
  });

  it('restore leaves a ref to another owner alone', () => {
    const text = 'image: ghcr.io/someone/shop:main\n';
    expect(restoreGitHubRefs(text, REFS)).toBe(text);
  });
});

describe('writeGitHubRefs', () => {
  function project(): string {
    const dir = createTempDir('vc-gh-refs-');
    for (const rel of GITHUB_REF_FILES) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), created(rel));
    }
    writeFileSync(join(dir, '.vibecarbon.json'), `${JSON.stringify({ projectName: PROJECT })}\n`);
    return dir;
  }
  const config = (dir: string) => JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));

  it('rewrites the files and records the pair upgrade re-applies', () => {
    const dir = project();
    const changed = writeGitHubRefs(dir, REFS);
    expect(changed.sort()).toEqual([...GITHUB_REF_FILES].sort());
    expect(config(dir).github).toEqual({ owner: 'acme', repo: 'shop' });
    expect(readFileSync(join(dir, 'k8s/flux/clusters/primary/vibecarbon.yaml'), 'utf-8')).toContain(
      'url: https://github.com/acme/shop\n',
    );
    expect(writeGitHubRefs(dir, REFS)).toEqual([]);
  });

  it('moves refs an earlier run pointed at another pair, repo name included', () => {
    const dir = project();
    writeGitHubRefs(dir, REFS);
    writeGitHubRefs(dir, { projectName: PROJECT, owner: 'neworg', repo: 'store' });
    for (const rel of GITHUB_REF_FILES) {
      const text = readFileSync(join(dir, rel), 'utf-8');
      expect(text, rel).not.toMatch(/(ghcr\.io|github\.com)\/acme\//);
      expect(
        restoreGitHubRefs(text, { projectName: PROJECT, owner: 'neworg', repo: 'store' }),
      ).toBe(created(rel));
    }
  });

  it('only the files it is given (the GitOps deploy passes the k8s ones)', () => {
    const dir = project();
    writeGitHubRefs(dir, { ...REFS, files: ['k8s/base/app/deployment.yaml'] });
    expect(readFileSync(join(dir, 'docker-compose.prod.yml'), 'utf-8')).toBe(
      created('docker-compose.prod.yml'),
    );
  });

  it('writes no .vibecarbon.json into a directory that has none', () => {
    const dir = project();
    const cfg = join(dir, '.vibecarbon.json');
    rmSync(cfg);
    writeGitHubRefs(dir, REFS);
    expect(existsSync(cfg)).toBe(false);
  });
});

describe('add-on entries in k8s/base/kustomization.yaml', () => {
  const base = readFileSync(join(CARBON, BASE_KUSTOMIZATION), 'utf-8');

  it('add lists the entry in resources, remove takes exactly that back out', () => {
    const one = addKustomizationEntry(base, 'redis/');
    const two = addKustomizationEntry(one, 'metabase/');
    expect(two).toMatch(/ {2}- traefik\/\n {2}- redis\/\n {2}- metabase\/\n\nlabels:/);
    expect(addKustomizationEntry(two, 'redis/')).toBe(two);
    expect(removeKustomizationEntry(removeKustomizationEntry(two, 'metabase/'), 'redis/')).toBe(
      base,
    );
    expect(removeKustomizationEntry(two, 'redis/')).toBe(addKustomizationEntry(base, 'metabase/'));
  });
});

describe('templateEdits', () => {
  const edits = templateEdits({
    projectName: PROJECT,
    github: { owner: 'acme', repo: 'shop' },
    addonEntries: ['redis/'],
  });

  it('applies and restores the GitHub refs on the ref files only', () => {
    const rel = 'k8s/flux/clusters/standby/vibecarbon.yaml';
    const applied = edits.apply(rel, created(rel));
    expect(applied).toBe(rewriteGitHubRefs(created(rel), REFS));
    expect(edits.restore(rel, applied)).toBe(created(rel));
    const other = 'image: ghcr.io/test-app/test-app\n';
    expect(edits.apply('k8s/base/app/hpa.yaml', other)).toBe(other);
  });

  it('restore is null for a file the edits are missing from: the user took them out', () => {
    // Without the edit the file reads as create made it, which matches the
    // stored checksum; the user changed it all the same.
    const rel = 'k8s/flux/clusters/primary/vibecarbon.yaml';
    expect(edits.restore(rel, created(rel))).toBeNull();
    expect(edits.restore(BASE_KUSTOMIZATION, created(BASE_KUSTOMIZATION))).toBeNull();
    // Add-on entries in the order they were added still restore: upgrade
    // knows which add-ons are installed, not in what order.
    const two = templateEdits({ projectName: PROJECT, addonEntries: ['metabase/', 'redis/'] });
    const base = created(BASE_KUSTOMIZATION);
    const redisFirst = addKustomizationEntry(addKustomizationEntry(base, 'redis/'), 'metabase/');
    expect(redisFirst).not.toBe(two.apply(BASE_KUSTOMIZATION, base));
    expect(two.restore(BASE_KUSTOMIZATION, redisFirst)).toBe(base);
    // Partly there is not there either.
    const mixed = `${edits.apply(rel, created(rel))}# ghcr.io/test-app/test-app\nimage: ghcr.io/test-app/test-app\n`;
    expect(edits.restore(rel, mixed)).toBeNull();
  });

  it('applies and restores the add-on entries on the base kustomization', () => {
    const base = created(BASE_KUSTOMIZATION);
    const applied = edits.apply(BASE_KUSTOMIZATION, base);
    expect(applied).toContain('  - redis/\n');
    expect(edits.restore(BASE_KUSTOMIZATION, applied)).toBe(base);
  });

  it('with nothing recorded, both pass content through', () => {
    const none = templateEdits({ projectName: PROJECT });
    for (const rel of [...GITHUB_REF_FILES, BASE_KUSTOMIZATION]) {
      expect(none.apply(rel, created(rel))).toBe(created(rel));
      expect(none.restore(rel, created(rel))).toBe(created(rel));
    }
  });
});

describe('the GitHub pair upgrade re-applies', () => {
  function repoWithOrigin(url: string): string {
    const dir = createTempDir('vc-gh-origin-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitSafeEnv() });
    git('init', '-q');
    git('remote', 'add', 'origin', url);
    return dir;
  }

  it('reads the origin remote locally, https or ssh', () => {
    expect(originGitHubRepo(repoWithOrigin('https://github.com/acme/shop.git'))).toEqual({
      owner: 'acme',
      repo: 'shop',
    });
    expect(originGitHubRepo(repoWithOrigin('git@github.com:acme/shop.git'))).toEqual({
      owner: 'acme',
      repo: 'shop',
    });
    expect(originGitHubRepo(repoWithOrigin('https://gitlab.com/acme/shop.git'))).toBeNull();
    expect(originGitHubRepo(createTempDir('vc-gh-none-'))).toBeNull();
  });

  it('prefers the recorded pair; falls back to origin only when CI/CD is on', () => {
    const dir = repoWithOrigin('https://github.com/fromorigin/shop.git');
    expect(recordedGitHubRepo(dir, { github: { owner: 'acme', repo: 'shop' } })).toEqual({
      owner: 'acme',
      repo: 'shop',
    });
    expect(recordedGitHubRepo(dir, { cicdEnabled: true })).toEqual({
      owner: 'fromorigin',
      repo: 'shop',
    });
    expect(recordedGitHubRepo(dir, {})).toBeNull();
  });
});
