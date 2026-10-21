/**
 * Census: nothing destroys a server that ran a primary database before its
 * writes are in the backup bucket (backup/restore integrity H6, B6).
 *
 * Compose scale used to destroy the old primary after a base pushed while it
 * still took writes: every write after that base was gone with the server. The
 * class is "a deleteServer of a primary whose last writes no base holds". Two
 * commands may destroy such a server:
 *
 *   - scale, through the write fence: fenceComposePrimary (writers stopped,
 *     database read-only, WAL archived through the fence), then a final base
 *     that must report `pushed`, and only then the old server goes;
 *   - destroy, after preDestroyBackup took a `pushed` base (or the operator
 *     chose -purge or -force, which preDestroyBackup names).
 *
 * Every other deleteServer under src/ must be on the allowlist with the reason
 * the server it deletes ran no primary database. The provider classes
 * (src/lib/providers/) implement deleteServer and clean up their own failed
 * creates; the in-cluster autoscaler (src/autoscaler/) deletes worker nodes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !isComment(l))
    .join('\n');

const srcFiles = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
  { cwd: ROOT, encoding: 'utf-8' },
)
  .stdout.split('\n')
  .filter((f) => f.endsWith('.js'));

/** Directories whose deleteServer calls are not a primary's teardown. */
const EXEMPT_DIRS: Record<string, string> = {
  'src/lib/providers/':
    'the provider classes implement deleteServer and delete their own half-created servers',
  'src/autoscaler/': 'the in-cluster autoscaler deletes worker nodes, which run no database',
};

type Rule = 'fenced' | 'destroy' | 'no-database';

/** Every top-level function under src/ that calls deleteServer, with its rule. */
const SITES: Record<string, { rule: Rule; why: string }> = {
  'src/scale.js#scaleServers': {
    rule: 'no-database',
    why: 'the standby arm destroys the old standby, which ran no primary (the primary arm destroys through finishComposeCutover)',
  },
  'src/scale.js#finishComposeCutover': {
    rule: 'fenced',
    why: 'the old primary goes only after its fence, a pushed final base restored on the new server, and the flip',
  },
  'src/scale.js#deleteUnusedReplacement': {
    rule: 'no-database',
    why: 'a replacement that never took over: DNS never pointed at it, so its restored copy never took a write',
  },
  'src/destroy.js#cleanupAutoscalerWorkers': {
    rule: 'no-database',
    why: 'autoscaler worker nodes run no database',
  },
  'src/destroy.js#destroyComposeTier': { rule: 'destroy', why: 'destroy, after preDestroyBackup' },
  'src/destroy.js#destroyK8sTier': { rule: 'destroy', why: 'destroy, after preDestroyBackup' },
  'src/lib/deploy/compose/ha.js#destroyComposeHA': {
    rule: 'destroy',
    why: 'destroy, after preDestroyBackup',
  },
  'src/lib/destroy/server-sweep.js#sweepEnvironmentServers': {
    rule: 'destroy',
    why: 'destroy, after preDestroyBackup',
  },
};

type Fn = { file: string; name: string; body: string };

/** Top-level functions: a column-0 `function` line up to the next column-0 `}`. */
function topLevelFunctions(file: string, text: string): Fn[] {
  const lines = text.split('\n');
  const out: Fn[] = [];
  lines.forEach((l, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/.exec(l);
    if (!m) return;
    let end = lines.findIndex((x, j) => j > i && /^\}\s*$/.test(x));
    if (end === -1) end = lines.length - 1;
    out.push({ file, name: m[1], body: code(lines.slice(i, end + 1).join('\n')) });
  });
  return out;
}

const DELETE = /\.deleteServer\(/;

describe('a server that ran a primary is destroyed only behind a pushed base', () => {
  const fns = srcFiles
    .filter((f) => !Object.keys(EXEMPT_DIRS).some((d) => f.startsWith(d)))
    .flatMap((f) => topLevelFunctions(f, read(f)));

  it('every deleteServer caller under src/ is on the census, and every entry still calls it', () => {
    const callers = fns.filter((f) => DELETE.test(f.body)).map((f) => `${f.file}#${f.name}`);
    expect(callers.sort()).toEqual(Object.keys(SITES).sort());
    // Nothing outside a top-level function (a module-scope or class call) slips past.
    const loose = srcFiles
      .filter((f) => !Object.keys(EXEMPT_DIRS).some((d) => f.startsWith(d)))
      .filter((f) => {
        const lines = read(f).split('\n');
        const inFns = topLevelFunctions(f, read(f));
        const n = lines.filter((l) => !isComment(l) && DELETE.test(l)).length;
        const m = inFns.reduce(
          (acc, fn) => acc + (fn.body.match(/\.deleteServer\(/g)?.length ?? 0),
          0,
        );
        return n !== m;
      });
    expect(loose).toEqual([]);
  });

  it('scale: the old primary is deleted after its write fence and a pushed final base', () => {
    const fn = (name: string) =>
      fns.find((f) => f.file === 'src/scale.js' && f.name === name)?.body ?? '';
    const body = fn('scaleServers');
    const arm = body.slice(
      body.indexOf('const scalePrimaryArm = async'),
      body.indexOf('const scaleStandbyArm = async'),
    );
    const fence = arm.indexOf('fenceComposePrimary(');
    const backup = arm.indexOf('backupCompose(');
    const pushed = arm.indexOf("backup.result !== 'pushed'");
    const restore = arm.indexOf('restoreCompose(');
    const journal = arm.indexOf('writeScaleCutoverJournal(');
    const finish = arm.indexOf('finishComposeCutover(');
    expect(fence).toBeGreaterThan(-1);
    expect(fence).toBeLessThan(backup);
    expect(backup).toBeLessThan(pushed);
    expect(pushed).toBeLessThan(restore);
    expect(restore).toBeLessThan(journal);
    expect(journal).toBeLessThan(finish);
    // The arm deletes nothing itself but the unused replacement, by its helper.
    expect(arm).not.toMatch(/deleteServer\(/);
    // The tail destroys the old server, and is reached only from that arm and
    // the resume of a journaled cutover (whose fence and base already ran).
    expect(fn('finishComposeCutover')).toMatch(/provider\.deleteServer\(server\.id\)/);
    const callers = fns
      .filter(
        (f) => f.name !== 'finishComposeCutover' && /(?<![\w.])finishComposeCutover\(/.test(f.body),
      )
      .map((f) => `${f.file}#${f.name}`)
      .sort();
    expect(callers).toEqual(['src/scale.js#resumeComposeCutover', 'src/scale.js#scaleServers']);
    expect(fn('resumeComposeCutover')).toMatch(/envConfig\.ha\.writeFence\.cutover/);
    // The standby arm deletes the old standby, never a primary.
    const standby = body.slice(body.indexOf('const scaleStandbyArm = async'));
    expect(standby).not.toMatch(/restoreCompose\(|backupCompose\(/);
  });

  it('destroy: every primary teardown runs from a destroy effect, after preDestroyBackup took a pushed base', () => {
    const destroy = code(read('src/destroy.js'));
    const main = fns.find((f) => f.file === 'src/destroy.js' && f.name === 'main')?.body ?? '';
    expect(main.indexOf('await preDestroyBackup(')).toBeGreaterThan(-1);
    expect(main.indexOf('await preDestroyBackup(')).toBeLessThan(
      main.indexOf('runPlan(planDestroy('),
    );
    const pre = fns.find((f) => f.file === 'src/destroy.js' && f.name === 'preDestroyBackup');
    expect(pre?.body).toMatch(/if \(backup\.result !== 'pushed'\) \{[\s\S]{0,80}return stop\(/);

    // The effects DESTROY_EFFECTS registers are the only roots.
    const registry = destroy.slice(destroy.indexOf('export const DESTROY_EFFECTS = {'));
    const effects = new Set(
      [...registry.slice(0, registry.indexOf('};')).matchAll(/(\w+Effect)\b/g)].map((m) => m[1]),
    );
    expect(effects.size).toBeGreaterThan(5);

    // Followed caller by caller up to an effect: a teardown function may be
    // called only from destroy.js, and only on paths that start at an effect.
    const callersOf = (name: string) => {
      const ref = new RegExp(`(?<![\\w.])${name}\\(`);
      // Drop the definition line, so a function is not its own caller.
      return fns.filter((f) => f.name !== name && ref.test(f.body));
    };
    const rooted = (name: string, seen: Set<string>): string[] => {
      if (effects.has(name)) return [];
      if (seen.has(name)) return [];
      seen.add(name);
      const callers = callersOf(name);
      if (callers.length === 0) return [`${name} is reached from no destroy effect`];
      return callers.flatMap((caller) =>
        caller.file === 'src/destroy.js'
          ? rooted(caller.name, seen)
          : [`${name} is called from ${caller.file}#${caller.name}`],
      );
    };
    const problems = Object.entries(SITES)
      .filter(([, v]) => v.rule === 'destroy')
      .flatMap(([k]) => rooted(k.split('#')[1], new Set()));
    expect(problems).toEqual([]);
  });
});
