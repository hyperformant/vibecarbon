import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addBranchWorktree,
  branches,
  git,
  makeBareBin,
  makeRig,
  type Rig,
  runHook,
  setMergedPrs,
  squashMerge,
} from './_repo.js';

const rigs: Rig[] = [];
const procs: ChildProcess[] = [];
const extraDirs: string[] = [];

function rig(def = 'main'): Rig {
  const r = makeRig(def);
  rigs.push(r);
  return r;
}

function run(
  r: Rig,
  opts: { projectDir?: string; path?: string; env?: Record<string, string> } = {},
) {
  return runHook('clean-merged.sh', {
    cwd: r.repo,
    env: opts.env,
    projectDir: opts.projectDir,
    path: opts.path ?? `${r.binDir}:${process.env.PATH}`,
  });
}

function hasTool(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
}

function context(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
}

afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  for (const r of rigs.splice(0)) {
    git(r.repo, 'worktree', 'prune');
    r.cleanup();
  }
  for (const d of extraDirs.splice(0)) spawnSync('rm', ['-rf', d]);
});

describe('.claude/hooks/clean-merged.sh', () => {
  it('removes a clean worktree and its branch once its PR merged, even when squashed', () => {
    const r = rig();
    const wt = addBranchWorktree(r, 'feat-a');
    squashMerge(r, 'feat-a');
    setMergedPrs(r, [`feat-a ${wt.tip}`]);
    const out = run(r);
    expect(out.status).toBe(0);
    expect(existsSync(wt.path)).toBe(false);
    expect(branches(r.repo)).not.toContain('feat-a');
    expect(context(out.stdout)).toContain(`Removed merged worktree ${wt.path} (feat-a)`);
  });

  it('deletes a merged branch that has no worktree', () => {
    const r = rig();
    git(r.repo, 'branch', 'old-work');
    git(r.repo, 'checkout', '-q', 'old-work');
    writeFileSync(join(r.repo, 'o.txt'), 'o\n');
    git(r.repo, 'add', '.');
    git(r.repo, 'commit', '-q', '-m', 'o');
    const tip = git(r.repo, 'rev-parse', 'HEAD');
    git(r.repo, 'checkout', '-q', r.def);
    squashMerge(r, 'other');
    setMergedPrs(r, [`old-work ${tip}`]);
    const out = run(r);
    expect(branches(r.repo)).not.toContain('old-work');
    expect(context(out.stdout)).toContain('Deleted merged branch old-work');
  });

  it('leaves a worktree with uncommitted changes and says why', () => {
    const r = rig();
    const wt = addBranchWorktree(r, 'feat-b');
    squashMerge(r, 'feat-b');
    setMergedPrs(r, [`feat-b ${wt.tip}`]);
    writeFileSync(join(wt.path, 'dirty.txt'), 'x\n');
    const out = run(r);
    expect(existsSync(wt.path)).toBe(true);
    expect(branches(r.repo)).toContain('feat-b');
    expect(context(out.stdout)).toContain(`Left ${wt.path} (feat-b): it has uncommitted changes`);
  });

  it.skipIf(process.platform !== 'linux')('leaves a worktree another process is working in', () => {
    const r = rig();
    const wt = addBranchWorktree(r, 'feat-c');
    squashMerge(r, 'feat-c');
    setMergedPrs(r, [`feat-c ${wt.tip}`]);
    const child = spawn('sleep', ['30'], { cwd: wt.path, stdio: 'ignore' });
    procs.push(child);
    const out = run(r);
    expect(existsSync(wt.path)).toBe(true);
    expect(context(out.stdout)).toContain(
      `Left ${wt.path} (feat-c): another process is working in it`,
    );
  });

  it("leaves the session's own worktree", () => {
    const r = rig();
    const wt = addBranchWorktree(r, 'feat-d');
    squashMerge(r, 'feat-d');
    setMergedPrs(r, [`feat-d ${wt.tip}`]);
    const out = run(r, { projectDir: wt.path });
    expect(existsSync(wt.path)).toBe(true);
    expect(context(out.stdout)).toContain(
      `Left ${wt.path} (feat-d): this session is working in it`,
    );
  });

  it('leaves a branch whose tip moved past its merged PR head', () => {
    const r = rig();
    const wt = addBranchWorktree(r, 'feat-e');
    squashMerge(r, 'feat-e');
    setMergedPrs(r, [`feat-e ${wt.tip}`]);
    writeFileSync(join(wt.path, 'more.txt'), 'more\n');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-q', '-m', 'more');
    const out = run(r);
    expect(existsSync(wt.path)).toBe(true);
    expect(branches(r.repo)).toContain('feat-e');
    expect(out.stdout).toBe('');
  });

  it('without gh, removes only branches already contained in the default branch', () => {
    const r = rig();
    const squashed = addBranchWorktree(r, 'feat-f');
    squashMerge(r, 'feat-f');
    const contained = addBranchWorktree(r, 'feat-g');
    git(r.repo, 'fetch', '-q', 'origin');
    git(r.repo, 'merge', '-q', '--no-ff', '-m', 'merge feat-g', 'origin/feat-g');
    git(r.repo, 'push', '-q', 'origin', r.def);
    const out = run(r, { path: makeBareBin(r) });
    expect(out.status).toBe(0);
    expect(existsSync(squashed.path)).toBe(true);
    expect(branches(r.repo)).toContain('feat-f');
    expect(existsSync(contained.path)).toBe(false);
    expect(branches(r.repo)).not.toContain('feat-g');
  });

  it('works when the default branch is master', () => {
    const r = rig('master');
    const wt = addBranchWorktree(r, 'feat-h');
    squashMerge(r, 'feat-h');
    setMergedPrs(r, [`feat-h ${wt.tip}`]);
    const out = run(r);
    expect(existsSync(wt.path)).toBe(false);
    expect(branches(r.repo)).toEqual(['master']);
    expect(context(out.stdout)).toContain('Removed merged worktree');
  });

  it('exits 0 and changes nothing with no remote, or outside a repo', () => {
    const r = rig();
    git(r.repo, 'remote', 'remove', 'origin');
    git(r.repo, 'branch', 'keep-me');
    const before = branches(r.repo);
    const out = run(r);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
    expect(branches(r.repo)).toEqual(before);

    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'vc-hooks-plain-')));
    extraDirs.push(plain);
    const outside = runHook('clean-merged.sh', { cwd: plain });
    expect(outside.status).toBe(0);
    expect(outside.stdout).toBe('');
  });

  it('prints additionalContext JSON naming what it did, and nothing when there was nothing to do', () => {
    const r = rig();
    expect(run(r).stdout).toBe('');
    const wt = addBranchWorktree(r, 'feat-i');
    squashMerge(r, 'feat-i');
    setMergedPrs(r, [`feat-i ${wt.tip}`]);
    const out = runHook('clean-merged.sh', {
      cwd: r.repo,
      event: 'SessionStart',
      path: `${r.binDir}:${process.env.PATH}`,
    });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('feat-i');
    expect(run(r).stdout).toBe('');
  });

  it('keeps a fresh worktree cut from the default branch that has no commits of its own', () => {
    const r = rig();
    const path = join(r.root, 'wt-fresh');
    git(r.repo, 'worktree', 'add', '-q', '-b', 'fresh', path, r.def);
    const noGh = run(r, { path: makeBareBin(r) });
    expect(noGh.status).toBe(0);
    expect(noGh.stdout).toBe('');
    setMergedPrs(r, []);
    const stubbed = run(r);
    expect(stubbed.stdout).toBe('');
    expect(existsSync(path)).toBe(true);
    expect(branches(r.repo)).toContain('fresh');
  });

  it('keeps a branch that was fast-forwarded into the default branch when gh cannot prove it merged', () => {
    const r = rig();
    const wt = addBranchWorktree(r, 'feat-ff');
    git(r.repo, 'fetch', '-q', 'origin');
    git(r.repo, 'merge', '-q', '--ff-only', 'origin/feat-ff');
    git(r.repo, 'push', '-q', 'origin', r.def);
    const out = run(r, { path: makeBareBin(r) });
    expect(out.stdout).toBe('');
    expect(existsSync(wt.path)).toBe(true);
    expect(branches(r.repo)).toContain('feat-ff');
  });

  it.skipIf(process.platform !== 'linux' || !hasTool('lsof'))(
    'leaves a worktree another process is working in, found by lsof',
    () => {
      const r = rig();
      const wt = addBranchWorktree(r, 'feat-l');
      squashMerge(r, 'feat-l');
      setMergedPrs(r, [`feat-l ${wt.tip}`]);
      const missing = join(r.root, 'no-proc');
      // No process: lsof finds nothing, the worktree goes.
      const free = addBranchWorktree(r, 'feat-m');
      squashMerge(r, 'feat-m');
      setMergedPrs(r, [`feat-l ${wt.tip}`, `feat-m ${free.tip}`]);
      const child = spawn('sleep', ['30'], { cwd: wt.path, stdio: 'ignore' });
      procs.push(child);
      const out = run(r, { env: { CLEAN_MERGED_PROC_DIR: missing } });
      expect(existsSync(wt.path)).toBe(true);
      expect(context(out.stdout)).toContain(
        `Left ${wt.path} (feat-l): another process is working in it`,
      );
      expect(existsSync(free.path)).toBe(false);
    },
  );

  it('leaves a worktree when it cannot tell whether something is working in it', () => {
    const r = rig();
    const wt = addBranchWorktree(r, 'feat-n');
    git(r.repo, 'fetch', '-q', 'origin');
    git(r.repo, 'merge', '-q', '--no-ff', '-m', 'merge feat-n', 'origin/feat-n');
    git(r.repo, 'push', '-q', 'origin', r.def);
    const out = run(r, {
      path: makeBareBin(r),
      env: { CLEAN_MERGED_PROC_DIR: join(r.root, 'no-proc') },
    });
    expect(existsSync(wt.path)).toBe(true);
    expect(context(out.stdout)).toContain(
      `Left ${wt.path} (feat-n): cannot tell whether something is working in it`,
    );
  });
});
