import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, makeRig, type Rig, runHook } from './_repo.js';

const rigs: Rig[] = [];

afterEach(() => {
  for (const r of rigs.splice(0)) r.cleanup();
});

/** Another clone pushes a new commit to the default branch of origin. */
function pushFromElsewhere(r: Rig): string {
  const other = join(r.root, 'other');
  git(r.root, 'clone', '--quiet', r.origin, other);
  writeFileSync(join(other, 'new.txt'), 'new\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'new');
  git(other, 'push', '-q', 'origin', r.def);
  return git(other, 'rev-parse', 'HEAD');
}

describe('.claude/hooks/ff-main.sh', () => {
  it('fast-forwards the default branch when it is master', () => {
    const r = makeRig('master');
    rigs.push(r);
    const tip = pushFromElsewhere(r);
    const out = runHook('ff-main.sh', { cwd: r.repo });
    expect(out.status).toBe(0);
    expect(git(r.repo, 'rev-parse', 'master')).toBe(tip);
  });

  it('never moves a default branch with local changes', () => {
    const r = makeRig('master');
    rigs.push(r);
    const before = git(r.repo, 'rev-parse', 'master');
    pushFromElsewhere(r);
    writeFileSync(join(r.repo, 'base.txt'), 'edited\n');
    const out = runHook('ff-main.sh', { cwd: r.repo });
    expect(out.status).toBe(0);
    expect(git(r.repo, 'rev-parse', 'master')).toBe(before);
  });
});
