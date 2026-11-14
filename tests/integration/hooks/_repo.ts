// Shared scaffolding for the hook tests: a bare origin, a clone of it, and
// helpers to run a hook script inside that clone. Real git and bash; the hook
// never sees any repository outside the temp dir.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitScrubbedEnv } from '../../_shared/git-env.js';

export const HOOKS_DIR = resolve(import.meta.dirname, '../../../.claude/hooks');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Hook Test',
  GIT_AUTHOR_EMAIL: 'hook@example.test',
  GIT_COMMITTER_NAME: 'Hook Test',
  GIT_COMMITTER_EMAIL: 'hook@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...gitScrubbedEnv({ isolateConfig: true }), ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface Rig {
  root: string;
  origin: string;
  repo: string;
  binDir: string;
  ghOut: string;
  def: string;
  cleanup: () => void;
}

/** A bare origin plus a clone with one commit on `def`, origin/HEAD set. */
export function makeRig(def = 'main'): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vc-hooks-')));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const binDir = join(root, 'bin');
  const ghOut = join(root, 'gh-out.txt');
  mkdirSync(binDir);
  writeFileSync(ghOut, '');
  git(root, 'init', '--bare', '-b', def, origin);
  git(root, 'clone', '--quiet', origin, repo);
  git(repo, 'checkout', '-q', '-B', def);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', '-u', 'origin', def);
  git(repo, 'remote', 'set-head', 'origin', def);
  // Stub gh: auth always works; `pr list` prints the canned lines.
  const gh = join(binDir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh\nif [ "$1" = auth ]; then exit 0; fi\nif [ "$1" = pr ]; then cat "${ghOut}"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(gh, 0o755);
  return {
    root,
    origin,
    repo,
    binDir,
    ghOut,
    def,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A worktree under the rig on a new branch with one pushed commit. */
export function addBranchWorktree(rig: Rig, name: string): { path: string; tip: string } {
  const path = join(rig.root, `wt-${name}`);
  git(rig.repo, 'worktree', 'add', '-q', '-b', name, path, rig.def);
  writeFileSync(join(path, `${name}.txt`), `${name}\n`);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', name);
  git(path, 'push', '-q', '-u', 'origin', name);
  return { path, tip: git(path, 'rev-parse', 'HEAD') };
}

/** Simulate a squash merge: the branch's change lands as a new default-branch commit. */
export function squashMerge(rig: Rig, name: string): void {
  writeFileSync(join(rig.repo, `${name}.txt`), `${name}\n`);
  git(rig.repo, 'add', '.');
  git(rig.repo, 'commit', '-q', '-m', `squash ${name}`);
  git(rig.repo, 'push', '-q', 'origin', rig.def);
}

export function setMergedPrs(rig: Rig, lines: string[]): void {
  writeFileSync(rig.ghOut, lines.length ? `${lines.join('\n')}\n` : '');
}

/** A bin dir holding only the tools the hooks need, so `gh` is not on PATH. */
export function makeBareBin(rig: Rig): string {
  const dir = join(rig.root, 'bin-nogh');
  mkdirSync(dir);
  for (const tool of [
    'git',
    'bash',
    'sed',
    'awk',
    'grep',
    'cat',
    'head',
    'tr',
    'sort',
    'readlink',
    'dirname',
    'basename',
    'ls',
  ]) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, join(dir, tool));
  }
  return dir;
}

export interface RunOpts {
  cwd: string;
  projectDir?: string;
  path?: string;
  event?: string;
  env?: Record<string, string>;
}

export function runHook(script: string, opts: RunOpts) {
  const r = spawnSync('bash', [join(HOOKS_DIR, script)], {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: opts.event ?? 'SessionStart', cwd: opts.cwd }),
    env: {
      ...gitScrubbedEnv({ isolateConfig: true }),
      ...GIT_ENV,
      PATH: opts.path ?? process.env.PATH ?? '',
      CLAUDE_PROJECT_DIR: opts.projectDir ?? opts.cwd,
      ...opts.env,
    },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function branches(repo: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean);
}

export function readText(p: string): string {
  return readFileSync(p, 'utf8');
}
