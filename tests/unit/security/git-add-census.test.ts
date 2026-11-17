/**
 * `git add` census.
 *
 * docs/security.md says every `git add` in src/ names the paths it stages,
 * with one exception: the initial commit in src/create.js, which stages
 * everything in a project create has just written into a directory that did
 * not exist before, after checking the .gitignore it wrote. Anywhere else, a
 * broad add can sweep an operator's untracked secrets into a commit that is
 * then pushed.
 *
 * This walks src/ so a new broad add fails here instead of making the doc
 * false.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../_shared/source-files.js';

const ROOT = process.cwd();

/** 'add' followed by an argument that stages more than named paths. */
const BROAD_ARGV = /['"]add['"]\s*,\s*['"](?:-A|--all|-u|--update|\.|\*|:\/)['"]/g;
/** A command written as one string: its paths cannot be checked here, so none is allowed. */
const STRING_COMMAND =
  /\b(?:runCommand|runCommandAsync|exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*['"`]git\s+add\b/g;

function hits(pattern: RegExp): string[] {
  return sourceFiles(join(ROOT, 'src'), { exts: ['.js'] }).flatMap((path) => {
    const count = [...readFileSync(path, 'utf-8').matchAll(pattern)].length;
    return Array(count).fill(relative(ROOT, path).split(sep).join('/'));
  });
}

describe('git add census', () => {
  it('the patterns recognise a broad add', () => {
    for (const text of [
      "['git', 'add', '-A']",
      '["git", "add", "."]',
      "['git', 'add', '--all']",
      "execFileSync('git', ['add', '-u'])",
    ]) {
      expect([...text.matchAll(BROAD_ARGV)].length, text).toBe(1);
    }
    expect([..."['git', 'add', 'k8s/']".matchAll(BROAD_ARGV)]).toEqual([]);
    expect([..."['git', 'add', '--', ...paths]".matchAll(BROAD_ARGV)]).toEqual([]);
    expect([..."runCommand('git add -A')".matchAll(STRING_COMMAND)].length).toBe(1);
    expect([...'runCommand(`git add k8s`)'.matchAll(STRING_COMMAND)].length).toBe(1);
    // Advice printed to the operator is not a command the CLI runs.
    expect([...'"run `git add -A && git commit` in the project"'.matchAll(STRING_COMMAND)]).toEqual(
      [],
    );
  });

  it("only create's initial commit stages everything", () => {
    expect(hits(BROAD_ARGV)).toEqual(['src/create.js']);
  });

  it('no git add is written as a single command string', () => {
    expect(hits(STRING_COMMAND)).toEqual([]);
  });

  it('only configure stages the whole allowlist, for a first commit', () => {
    // buildGitAddArgv stages every allowlisted path that changed. That is
    // right for the first commit of a project that has none, and wrong for a
    // command that wrote one file: deploy staged the operator's work in
    // progress along with the lockfile it had generated. A command that means
    // one file uses buildGitAddNamedArgv.
    expect(hits(/\bbuildGitAddArgv\(/g)).toEqual(['src/configure.js', 'src/lib/project.js']);
  });

  it('create checks the .gitignore it wrote before the repository exists', () => {
    // What makes the one broad add safe: the ignore patterns are verified
    // (the CLI exits if one is missing) before `git init`, and so before the add.
    const create = readFileSync(join(ROOT, 'src', 'create.js'), 'utf-8');
    const validated = create.indexOf("validateGitignore(join(projectDir, '.gitignore'))");
    const init = create.indexOf("runCommand('git init'");
    const add = create.search(BROAD_ARGV);
    expect(validated).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(validated);
    expect(add).toBeGreaterThan(init);
  });
});
