/**
 * The edits the CLI itself makes to template files after `create`, and how
 * `upgrade` tells them apart from the user's.
 *
 * `create` and `upgrade` record a checksum for every template file they lay
 * down; `upgrade` reads a file whose content no longer matches it as edited
 * by the user and only offers it for review (`-y` writes `.upgrade-new`
 * beside it). Two commands edit some of those files on the project's behalf:
 *
 *   - `configure cicd`, and the GitOps deploy it runs, point the GitHub image
 *     and clone refs at the real owner and repo (GITHUB_REF_FILES; `create`
 *     bakes both as the project name).
 *   - `add` / `remove` list an add-on's directory in k8s/base/kustomization.yaml.
 *
 * A stored checksum is always of the file WITHOUT these edits. `upgrade`
 * undoes them before it compares (`restore`) and makes them again on what it
 * writes (`apply`), so a file only the CLI changed upgrades like an untouched
 * one and keeps the edits, and a file the user changed is still offered for
 * review, with the edits already in the version on offer. The commands that
 * edit need no checksum bookkeeping, and a project edited before this module
 * existed is read correctly on its next upgrade, with nothing to re-run.
 *
 * Before this, configure's rewrite made upgrade -y leave the Flux cluster
 * files as they were while k8s/base moved: Flux applied the Traefik
 * Deployment with a literal {{TRAEFIK_IMAGE}} the new cluster files strip.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashContent } from './checksum.js';
import { gitSafeEnv } from './command.js';
import { readProjectConfigFile, updateProjectConfig } from './config.js';

/**
 * Every template file with a `ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}` or
 * `github.com/{{GITHUB_OWNER}}/{{PROJECT_NAME}}` ref. Census:
 * tests/unit/lib/template-edits.test.ts walks carbon/ both ways. (Both old
 * rewrites also listed k8s/base/backup/cronjob.yaml, which has carried no
 * GitHub ref since the first public release.)
 */
export const GITHUB_REF_FILES = Object.freeze([
  'docker-compose.prod.yml',
  'k8s/base/app/deployment.yaml',
  'k8s/overlays/production/kustomization.yaml',
  'k8s/flux/clusters/primary/vibecarbon.yaml',
  'k8s/flux/clusters/standby/vibecarbon.yaml',
]);

/** The add-on entries' file (`add` and `remove` edit its `resources:`). */
export const BASE_KUSTOMIZATION = 'k8s/base/kustomization.yaml';

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Not followed by a name character, so `test-app` never matches inside
// `test-app-other`; a `:tag` or a `.git` suffix stays where it is.
const END = '(?![\\w-])';

/**
 * Point the project's GitHub refs at `owner/repo`: the app image refs
 * `ghcr.io/<any>/<projectName>[-db|-backup]` and the Flux clone URL
 * `github.com/<any>/<projectName>`. A ref to another repo is left alone.
 *
 * @param {string} content
 * @param {{ projectName: string, owner: string, repo: string }} refs
 * @returns {string}
 */
export function rewriteGitHubRefs(content, { projectName, owner, repo }) {
  const pn = escapeForRegex(projectName);
  return content
    .replace(
      new RegExp(`ghcr\\.io/[^/\\s:'"]+/${pn}(-db|-backup)?${END}`, 'g'),
      (_m, suffix) => `ghcr.io/${owner}/${repo}${suffix ?? ''}`,
    )
    .replace(
      new RegExp(`github\\.com/[^/\\s:'"]+/${pn}${END}`, 'g'),
      () => `github.com/${owner}/${repo}`,
    );
}

/**
 * The inverse of rewriteGitHubRefs: `owner/repo` refs back to the
 * `<projectName>/<projectName>` that `create` writes.
 *
 * @param {string} content
 * @param {{ projectName: string, owner: string, repo: string }} refs
 * @returns {string}
 */
export function restoreGitHubRefs(content, { projectName, owner, repo }) {
  const pair = `${escapeForRegex(owner)}/${escapeForRegex(repo)}`;
  return content
    .replace(
      new RegExp(`ghcr\\.io/${pair}(-db|-backup)?${END}`, 'g'),
      (_m, suffix) => `ghcr.io/${projectName}/${projectName}${suffix ?? ''}`,
    )
    .replace(
      new RegExp(`github\\.com/${pair}${END}`, 'g'),
      () => `github.com/${projectName}/${projectName}`,
    );
}

/**
 * The GitHub `{ owner, repo }` of the project's `origin` remote, from the
 * local git config only (no network), or null.
 *
 * @param {string} cwd
 * @returns {{ owner: string, repo: string } | null}
 */
export function originGitHubRepo(cwd) {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      env: gitSafeEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Point the project's GitHub refs at `owner/repo` in `files`, and record the
 * pair in `.vibecarbon.json` (`github`) so upgrade makes the same edit on
 * what it writes. Refs an earlier run pointed at the previously recorded pair
 * move too. The one writer for `configure cicd` and the GitOps deploy.
 *
 * @param {string} cwd
 * @param {{ projectName: string, owner: string, repo: string, files?: readonly string[] }} args
 * @returns {string[]} the files whose content changed
 */
export function writeGitHubRefs(cwd, { projectName, owner, repo, files = GITHUB_REF_FILES }) {
  const config = readProjectConfigFile(cwd);
  const prior = config?.github;
  const changed = [];
  for (const rel of files) {
    const path = join(cwd, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf-8');
    const created =
      prior?.owner && prior?.repo ? restoreGitHubRefs(before, { projectName, ...prior }) : before;
    const after = rewriteGitHubRefs(created, { projectName, owner, repo });
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(rel);
    }
  }
  if (config && (prior?.owner !== owner || prior?.repo !== repo)) {
    updateProjectConfig((c) => {
      c.github = { owner, repo };
    }, cwd);
  }
  return changed;
}

/**
 * Record the checksum of a template file a command other than `create` wrote
 * whole (the CI workflows `configure cicd` installs), as `create` and `add`
 * record theirs: without one, upgrade reads the file as yours forever and
 * never replaces it. Nothing to record into without a `.vibecarbon.json`.
 *
 * @param {string} cwd
 * @param {string} rel
 * @param {string} content - what was written
 */
export function recordInstalledFile(cwd, rel, content) {
  if (!readProjectConfigFile(cwd)) return;
  updateProjectConfig((c) => {
    c.fileChecksums = { ...(c.fileChecksums ?? {}), [rel]: hashContent(content) };
  }, cwd);
}

/**
 * Insert `  - <entry>` at the end of the `resources:` list, the way `add`
 * always has: before the first `labels:` / `commonLabels:` key, else at the
 * end. Present already: unchanged.
 *
 * @param {string} content
 * @param {string} entry - e.g. `redis/`
 * @returns {string}
 */
export function addKustomizationEntry(content, entry) {
  const line = `  - ${entry}`;
  if (content.split('\n').some((l) => l.trimEnd() === line)) return content;
  const labelsIndex = content.indexOf('labels:');
  const commonLabelsIndex = content.indexOf('commonLabels:');
  const insertBefore = labelsIndex !== -1 ? labelsIndex : commonLabelsIndex;
  if (insertBefore === -1) return `${content.trimEnd()}\n${line}\n`;
  return `${content.slice(0, insertBefore).trimEnd()}\n${line}\n\n${content.slice(insertBefore)}`;
}

/**
 * The inverse of addKustomizationEntry: drop the `  - <entry>` line.
 *
 * @param {string} content
 * @param {string} entry
 * @returns {string}
 */
export function removeKustomizationEntry(content, entry) {
  const line = `  - ${entry}`;
  return content
    .split('\n')
    .filter((l) => l.trimEnd() !== line)
    .join('\n');
}

/**
 * The CLI's edits for one project, as two functions over a file's content:
 * `apply` makes them (on what upgrade writes), `restore` undoes them (before
 * upgrade compares with, or records, a checksum). A file no edit touches
 * passes through both unchanged. `restore` gives null for content the edits
 * did not make (one missing, or only partly there), so it never matches.
 *
 * The GitHub pair is the one configure recorded; a project configured before
 * it was recorded falls back to its `origin` remote, read locally, only when
 * CI/CD is on (nothing else rewrites the refs). The add-on entries are those
 * of the installed add-ons that declare one.
 *
 * @param {{ projectName: string, github?: { owner: string, repo: string } | null,
 *   addonEntries?: string[] }} edits
 * @returns {{ apply: (rel: string, content: string) => string,
 *   restore: (rel: string, content: string) => string | null }}
 */
export function templateEdits({ projectName, github = null, addonEntries = [] }) {
  const refs = projectName && github?.owner && github?.repo ? { projectName, ...github } : null;
  const isRefFile = (rel) => refs && GITHUB_REF_FILES.includes(rel);
  const apply = (rel, content) => {
    let out = content;
    if (isRefFile(rel)) out = rewriteGitHubRefs(out, refs);
    if (rel === BASE_KUSTOMIZATION) {
      for (const entry of addonEntries) out = addKustomizationEntry(out, entry);
    }
    return out;
  };
  // Only the edits' own output restores: a file the user took an edit out
  // of (a ref put back, an add-on entry deleted) undoes to exactly what
  // create made, and would read as untouched while it is the user's.
  const restore = (rel, content) => {
    let out = content;
    if (isRefFile(rel)) {
      out = restoreGitHubRefs(out, refs);
      if (rewriteGitHubRefs(out, refs) !== content) return null;
    }
    if (rel === BASE_KUSTOMIZATION) {
      // Present is enough: add lists them in the order they were added,
      // which the project does not record.
      const lines = new Set(out.split('\n').map((l) => l.trimEnd()));
      if (!addonEntries.every((entry) => lines.has(`  - ${entry}`))) return null;
      for (const entry of addonEntries) out = removeKustomizationEntry(out, entry);
    }
    return out;
  };
  return { apply, restore };
}

/**
 * The GitHub pair upgrade re-applies: what configure recorded, else (CI/CD
 * on, recorded before this) the `origin` remote, else none.
 *
 * @param {string} cwd
 * @param {{ github?: { owner?: string, repo?: string }, cicdEnabled?: boolean }} manifest
 * @returns {{ owner: string, repo: string } | null}
 */
export function recordedGitHubRepo(cwd, manifest) {
  if (manifest?.github?.owner && manifest.github.repo) {
    return { owner: manifest.github.owner, repo: manifest.github.repo };
  }
  return manifest?.cicdEnabled === true ? originGitHubRepo(cwd) : null;
}
