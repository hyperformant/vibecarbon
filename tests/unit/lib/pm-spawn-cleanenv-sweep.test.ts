/**
 * CALL-SITE SWEEP: every package-manager spawn must pass `cleanEnv: true`.
 *
 * The leak this guards is the package-manager run context — npm, pnpm and bun
 * publish their resolved config into children as lowercase `npm_config_*` (plus
 * `npm_execpath`, `npm_command`, `npm_lifecycle_*`, `pnpm_config_*`), so a
 * `vibecarbon` reached through `pnpm dlx` / `bunx` hands the WRAPPER's dialect
 * to the npm we spawn in the generated project. `cleanEnv` is what drops it;
 * see PM_RUN_CONTEXT_RE in src/lib/command.js for the 2026-08-05 EALLOWSCRIPTS
 * incident that made it a hard failure rather than a warning.
 *
 * Why a sweep and not an inventory: this is the THIRD round of the same class
 * (integration fixtures, then the e2e harness, now the product path), and every
 * round was "the fix was right, one call site was missed". `create` had
 * `cleanEnv` on its four spawns while `upgrade` and `up` did not — nothing
 * failed, because the guard was a habit rather than a check. A sweep fails on
 * the call site that forgot, including one added next month.
 *
 * Round four (2026-08-15): the sweep itself had the miss. It only matched the
 * lib/command.js helpers, so `up`'s RAW `spawn(pm, …)` for dev:start — which
 * cannot take `cleanEnv` — sailed through, and npm 12 printed the wrapper's
 * `npm warn Unknown env config` dialect on every `vibecarbon up`. Raw
 * child_process spawns of a package manager are now swept too: they must pass
 * `env: gitSafeEnv(…)` (the exported form of the same scrub).
 *
 * Deliberately source-text based: the alternative is executing every command
 * path, which needs a real registry and a real install.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** The spawn helpers in src/lib/command.js that accept `cleanEnv`. */
const SPAWN_FNS = ['runCommand', 'runCommandAsync', 'runCommandThroughTaskLog'];

/**
 * Raw node:child_process spawns. These have no `cleanEnv` option, so when the
 * command is a package manager they must scrub explicitly via
 * `env: gitSafeEnv(…)`.
 */
const RAW_SPAWN_FNS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];

/** First argument of a raw spawn that names a package manager. */
const RAW_PM_ARG_RE = /^\s*(?:pm|packageManager|['"](?:npm|pnpm|bun)['"])\s*,/;

/**
 * A call whose command argument invokes a package manager.
 *
 * Covers both spellings the codebase uses: an argv array opening with a literal
 * (`['npm', 'ci', …]`) or with the detected-manager variable (`[pm, …]`,
 * `[packageManager, …]`), and the string form (`'pnpm install …'`). Bare
 * variables holding a prebuilt command (`installCmd`, `lockfileCmd`) are named
 * explicitly — they are the two the product uses and both are PM commands.
 */
const PM_COMMAND_RE = new RegExp(
  [
    String.raw`\[\s*['"](?:npm|pnpm|bun)['"]`,
    String.raw`\[\s*(?:pm|packageManager)\s*[,\]]`,
    `['"](?:npm|pnpm|bun) (?:install|ci|run|exec)`,
    String.raw`\b(?:installCmd|lockfileCmd)\b`,
  ].join('|'),
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Every package-manager spawn call site, as `file:line`.
 *
 * A call can span lines, so each match is read from the opening paren to its
 * balanced close rather than by a line-oriented regex.
 */
function findPmSpawnCalls(): { site: string; raw: boolean; scrubbed: boolean }[] {
  const found: { site: string; raw: boolean; scrubbed: boolean }[] = [];

  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf-8');
    for (const fn of [...SPAWN_FNS, ...RAW_SPAWN_FNS]) {
      const raw = RAW_SPAWN_FNS.includes(fn);
      const opener = new RegExp(String.raw`\b${fn}\s*\(`, 'g');
      for (const m of text.matchAll(opener)) {
        const start = (m.index ?? 0) + m[0].length;
        let depth = 1;
        let i = start;
        for (; i < text.length && depth > 0; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') depth--;
        }
        const call = text.slice(start, i - 1);
        if (raw ? !RAW_PM_ARG_RE.test(call) : !PM_COMMAND_RE.test(call)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        found.push({
          site: `${relative(ROOT, file)}:${line}`,
          raw,
          scrubbed: raw
            ? /\benv\s*:\s*gitSafeEnv\s*\(/.test(call)
            : /\bcleanEnv\s*:\s*true\b/.test(call),
        });
      }
    }
  }
  return found;
}

describe('every package-manager spawn scrubs the wrapper run context', () => {
  const calls = findPmSpawnCalls();

  it('finds the known call sites (the sweep is actually sweeping)', () => {
    // Positive control. If a refactor renames the helpers or the command
    // spelling, this drops to zero and every assertion below passes vacuously
    // — the failure mode that makes a green sweep worthless.
    expect(
      calls.map((c) => c.site),
      'no package-manager spawns found in src/ — the sweep stopped matching',
    ).not.toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    // `up`'s dev:start raw spawn is the known member of the raw category; if
    // this drops to zero the raw half of the sweep stopped matching.
    expect(
      calls.filter((c) => c.raw).length,
      'no RAW package-manager spawns found in src/ — the raw half of the sweep stopped matching',
    ).toBeGreaterThanOrEqual(1);
  });

  it('scrubs the run context at every one of them', () => {
    const missing = calls
      .filter((c) => !c.scrubbed)
      .map((c) => `${c.site}${c.raw ? ' (raw spawn: pass `env: gitSafeEnv()`)' : ''}`);
    expect(
      missing,
      'these spawn a package manager without scrubbing the wrapper run context, so the ' +
        "wrapper package manager's injected npm_config_* reaches the child. That is how " +
        '`vibecarbon create` died with EALLOWSCRIPTS on npm 12 (2026-08-05), and how ' +
        '`vibecarbon up` sprayed `npm warn Unknown env config` (2026-08-15). Helper calls ' +
        'take `cleanEnv: true`; raw child_process spawns take `env: gitSafeEnv()`.',
    ).toEqual([]);
  });
});
