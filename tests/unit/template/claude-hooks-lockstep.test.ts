/**
 * The repo and the template both ship Claude Code hooks. A hook that exists in
 * one place and not the other means new projects miss a fix, or the repo runs
 * something the template never tested. This census keeps them in lockstep:
 * every repo hook is byte-identical in the template, or says why it is not.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const REPO_HOOKS = join(REPO_ROOT, '.claude', 'hooks');
const TEMPLATE_HOOKS = join(REPO_ROOT, 'carbon', '.claude', 'hooks');
const SETTINGS = ['.claude/settings.json', 'carbon/.claude/settings.json'];

/** Hooks that exist in both places but differ on purpose, with the reason. */
const TEMPLATE_VARIANTS: Record<string, string> = {
  'task-completed-gate.sh': 'the repo runs `pnpm test:unit`, the template runs `npm test`',
  'teammate-idle-gate.sh':
    'the template uses npm and also runs `npm run test:security`, which the repo has no equivalent of',
};

/** Hooks that only make sense in this repo, with the reason. */
const REPO_ONLY: Record<string, string> = {};

const scripts = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.sh'));

type HookEntry = { event: string; matcher: string; hook: Record<string, unknown> };

function entries(file: string): HookEntry[] {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8'));
  const out: HookEntry[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups as Array<{
      matcher?: string;
      hooks: Array<Record<string, unknown>>;
    }>) {
      for (const hook of group.hooks) out.push({ event, matcher: group.matcher ?? '', hook });
    }
  }
  return out;
}

const scriptOf = (command: string) => command.match(/\/\.claude\/hooks\/([\w.-]+\.sh)/)?.[1];

describe('claude hooks lockstep', () => {
  it('every repo hook ships in the template byte for byte, or says why not', () => {
    const template = scripts(TEMPLATE_HOOKS);
    for (const name of scripts(REPO_HOOKS)) {
      if (name in REPO_ONLY) {
        expect(template, `${name} is REPO_ONLY but also ships`).not.toContain(name);
      } else if (name in TEMPLATE_VARIANTS) {
        expect(template, `${name} is a variant but missing in the template`).toContain(name);
        expect(
          readFileSync(join(REPO_HOOKS, name), 'utf-8'),
          `${name} is listed as a variant but is identical; remove it from TEMPLATE_VARIANTS`,
        ).not.toBe(readFileSync(join(TEMPLATE_HOOKS, name), 'utf-8'));
      } else {
        expect(template, `${name} is missing from carbon/.claude/hooks/`).toContain(name);
        expect(
          readFileSync(join(TEMPLATE_HOOKS, name)).equals(readFileSync(join(REPO_HOOKS, name))),
          `${name} differs between .claude/hooks and carbon/.claude/hooks; copy it, or list it in TEMPLATE_VARIANTS with the reason`,
        ).toBe(true);
      }
    }
    for (const name of template) {
      expect(
        scripts(REPO_HOOKS).includes(name),
        `carbon/.claude/hooks/${name} has no repo copy`,
      ).toBe(true);
    }
  });

  it('the shared hooks are wired the same way in both settings files', () => {
    const shared = scripts(REPO_HOOKS).filter(
      (n) => !(n in TEMPLATE_VARIANTS) && !(n in REPO_ONLY),
    );
    expect(shared.length).toBeGreaterThan(0);
    const pick = (file: string) =>
      entries(file)
        .filter((e) => shared.includes(scriptOf(String(e.hook.command)) ?? ''))
        .map((e) => JSON.stringify(e))
        .sort();
    const [repo, template] = SETTINGS.map(pick);
    expect(template).toEqual(repo);
    for (const name of shared) {
      expect(
        repo.some((e) => e.includes(`/${name}`)),
        `${name} ships but no settings entry runs it`,
      ).toBe(true);
    }
  });

  it('every script either settings file runs exists and is executable in git', () => {
    const modes = new Map<string, string>();
    for (const line of execFileSync(
      'git',
      ['ls-files', '-s', '.claude/hooks', 'carbon/.claude/hooks'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      },
    )
      .split('\n')
      .filter(Boolean)) {
      const [meta, path] = line.split('\t');
      modes.set(path, meta.split(' ')[0]);
    }
    for (const file of SETTINGS) {
      const dir = file.startsWith('carbon/') ? 'carbon/.claude/hooks' : '.claude/hooks';
      for (const { hook } of entries(file)) {
        const name = scriptOf(String(hook.command));
        expect(name, `${file}: cannot find a script in ${hook.command}`).toBeTruthy();
        expect(modes.get(`${dir}/${name}`), `${dir}/${name} is not tracked as 100755`).toBe(
          '100755',
        );
      }
    }
  });
});
