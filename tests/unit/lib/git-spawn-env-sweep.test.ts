import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitSafeEnv } from '../../../src/lib/command.js';

// Call-site sweep: every git spawn must have the repo-context env scrubbed.
//
// git EXPORTS GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_PREFIX into every
// process it runs from a hook — this repo's own pre-push runs the integration
// suite, and users run husky, lefthook or the pre-commit framework. GIT_DIR
// OVERRIDES cwd, so passing `cwd` is not protection: the probe silently reads
// the HOST repo and answers confidently about the wrong tree.
//
// #234 hit this and fixed ONE probe (the R8 compose inventory) by scrubbing
// GIT_* for that single call. The rest of the family stayed unprotected, and
// the existing cleanEnv sweep could not see them: it is scoped to
// package-manager COMMANDS, so a `git` spawn is invisible to it.
//
// The consequential ones:
//   - secret-scan.js `git ls-files` — the PRE-DEPLOY SECRET SCAN enumerates the
//     host repo and reports the project clean. A silent security pass.
//   - github.js `git checkout <branch>` — executes against the host repo.
//   - upgrade.js `git status --porcelain` — the uncommitted-changes guard reads
//     the wrong repo and reports clean, removing the only warning before
//     upgrade rewrites template files.
//   - image.js — stamps the host repo's sha/dirty flag onto the built image.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const srcRoot = join(repoRoot, 'src');

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('git spawns scrub the inherited repo context', () => {
  it('gitSafeEnv drops GIT_DIR and friends but keeps identity/transport vars', () => {
    const scrubbed = gitSafeEnv({
      GIT_DIR: '/host/.git',
      GIT_WORK_TREE: '/host',
      GIT_INDEX_FILE: '/tmp/idx',
      GIT_PREFIX: 'sub/',
      GIT_AUTHOR_NAME: 'Brandon Powers',
      GIT_SSH_COMMAND: 'ssh -i key',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);

    expect(scrubbed.GIT_DIR).toBeUndefined();
    expect(scrubbed.GIT_WORK_TREE).toBeUndefined();
    expect(scrubbed.GIT_INDEX_FILE).toBeUndefined();
    expect(scrubbed.GIT_PREFIX).toBeUndefined();
    // Identity and transport are USER config, not repo context — dropping them
    // would break signed commits and custom SSH keys.
    expect(scrubbed.GIT_AUTHOR_NAME).toBe('Brandon Powers');
    expect(scrubbed.GIT_SSH_COMMAND).toBe('ssh -i key');
    expect(scrubbed.PATH).toBe('/usr/bin');
  });

  it('does not mutate the env it is handed', () => {
    const env = { GIT_DIR: '/host/.git' } as NodeJS.ProcessEnv;
    gitSafeEnv(env);
    expect(env.GIT_DIR).toBe('/host/.git');
  });

  it('every direct git spawn under src/ passes a scrubbed env', () => {
    const offenders: string[] = [];
    for (const file of jsFiles(srcRoot)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (!/(execFileSync|spawnSync|execFile|spawn)\(\s*['"]git['"]/.test(line)) return;
        // Options object follows the argv array; look a few lines ahead.
        const window = lines.slice(i, i + 8).join('\n');
        if (!/env:\s*gitSafeEnv\(/.test(window)) {
          offenders.push(`${relative(repoRoot, file)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      'A direct git spawn inherits GIT_DIR from any hook wrapper, which OVERRIDES ' +
        'cwd and points the command at the host repo. Pass `env: gitSafeEnv()`:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every runCommand git spawn under src/ opts into cleanEnv', () => {
    const offenders: string[] = [];
    for (const file of jsFiles(srcRoot)) {
      const src = readFileSync(file, 'utf-8');
      const re = /runCommand(?:Async|ThroughTaskLog)?\(\s*\[\s*['"]git['"][\s\S]{0,400}?\)/g;
      for (const match of src.matchAll(re)) {
        if (/cleanEnv:\s*true/.test(match[0])) continue;
        const line = src.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(repoRoot, file)}:${line}`);
      }
    }
    expect(
      offenders,
      'runCommand spawns of git must pass `cleanEnv: true` so the hook-injected ' +
        'GIT_* repo context is scrubbed:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
