/**
 * Census: a backup's outcome is read at every call site.
 *
 * `backupCompose` and `triggerBackupJob` return `{ result, name?, reason? }`
 * (parsed from the script's BACKUP_RESULT marker). A caller that only awaits
 * the call treats `skipped` as success, which is how a destroy or a scale used
 * to proceed on a standby's or an unconfigured env's "backup" that never
 * happened. Every call under src/ must destructure `result` or read
 * `<binding>.result`, and the marker is parsed in exactly one place.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const srcFiles = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
  {
    cwd: ROOT,
    encoding: 'utf-8',
  },
)
  .stdout.split('\n')
  .filter((f) => f.endsWith('.js'));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
/** Code lines only: a doc comment naming the marker is not a parser. */
const code = (f: string) =>
  read(f)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const RUNNERS = ['backupCompose', 'triggerBackupJob'];

/**
 * The only places a backup runner may be bound to another name: deps defaults
 * (test seams). `alias` is a name the census then treats as a runner, so
 * calls through it are checked too; `loader` lines are the lazy-import
 * pass-throughs whose `run(...)` hands the result straight back to the deps
 * default's caller.
 */
const ALIAS_ALLOW: Array<{ file: string; text: string; alias?: string }> = [
  { file: 'src/backup.js', text: 'triggerJob = triggerBackupJob,', alias: 'triggerJob' },
  {
    file: 'src/backup.js',
    text: "const { backupCompose: run } = await import('./lib/deploy/compose/index.js');",
  },
  {
    file: 'src/destroy.js',
    text: "const { backupCompose: run } = await import('./lib/deploy/compose/index.js');",
  },
  {
    file: 'src/destroy.js',
    text: "const { triggerBackupJob: run } = await import('./backup.js');",
  },
];

const RENAME = new RegExp(`\\b(?:${RUNNERS.join('|')})\\s*:\\s*\\w+`);
const VALUE = new RegExp(
  `\\b\\w+\\s*=\\s*(?:[\\w.]+\\.)?(?:${RUNNERS.join('|')})\\b(?!\\s*[\\w(])`,
);
const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);

/** Lines that bind a runner to another name. */
function aliasLines(file: string, text: string) {
  return text
    .split('\n')
    .map((l, i) => ({ file, line: i + 1, text: l.trim() }))
    .filter(({ text: l }) => !isComment(l) && (RENAME.test(l) || VALUE.test(l)));
}

/**
 * Every runner call in `text` whose result is not read: the call must be
 * destructured with `result`, or bound (`x = await <runner>(` or
 * `x = await perfAsync(…, () => <runner>(`) with `x.result` read later in the
 * SAME top-level declaration (up to the next column-0 `}`), not merely
 * somewhere in the file.
 */
function unconsumedCalls(text: string, callees: string[]) {
  const lines = text.split('\n');
  const call = new RegExp(`(?<![\\w.])(${callees.join('|')})\\(`);
  const out: Array<{ line: number; text: string }> = [];
  lines.forEach((l, i) => {
    if (isComment(l) || !call.test(l) || /\bfunction\s+\w+\(/.test(l)) return;
    if (
      new RegExp(`\\{[^}]*\\bresult\\b[^}]*\\}\\s*=\\s*await\\s+(${callees.join('|')})\\(`).test(l)
    )
      return;
    const bound = new RegExp(
      `\\b(\\w+)\\s*=\\s*await\\s+(?:perfAsync\\([^,]+,\\s*(?:async\\s*)?\\(\\)\\s*=>\\s*(?:await\\s+)?)?(?:${callees.join('|')})\\(`,
    ).exec(l);
    let end = lines.findIndex((x, j) => j > i && /^\}/.test(x));
    if (end === -1) end = lines.length;
    const scope = lines.slice(i, end + 1).join('\n');
    if (bound && new RegExp(`\\b${bound[1]}\\.result\\b`).test(scope)) return;
    out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

describe('backup results are consumed', () => {
  const perFile = srcFiles.map((file) => {
    const text = read(file);
    const aliases = ALIAS_ALLOW.filter((a) => a.file === file && a.alias).map(
      (a) => a.alias as string,
    );
    return { file, text, callees: [...RUNNERS, ...aliases] };
  });

  it('finds the known call sites (backup create, destroy, scale, the post-promote push)', () => {
    const call = new RegExp(`(?<![\\w.])(${RUNNERS.join('|')}|triggerJob)\\(`);
    const files = perFile
      .filter(({ file, text }) =>
        text
          .split('\n')
          .some(
            (l) =>
              !isComment(l) &&
              call.test(l) &&
              !/function\s/.test(l) &&
              file !== 'src/lib/deploy/compose/index.js',
          ),
      )
      .map((f) => f.file)
      .sort();
    expect(files).toEqual([
      'src/backup.js',
      'src/destroy.js',
      'src/lib/walg/post-promote-backup.js',
      'src/scale.js',
    ]);
  });

  it('every call reads .result within its own function', () => {
    const bad = perFile.flatMap(({ file, text, callees }) =>
      unconsumedCalls(text, callees).map((c) => `${file}:${c.line}: ${c.text}`),
    );
    expect(bad).toEqual([]);
  });

  it('a runner is bound to another name only in the deps-default allowlist', () => {
    const found = perFile.flatMap(({ file, text }) => aliasLines(file, text));
    const unexpected = found.filter(
      (f) => !ALIAS_ALLOW.some((a) => a.file === f.file && a.text === f.text),
    );
    expect(unexpected.map((u) => `${u.file}:${u.line}: ${u.text}`)).toEqual([]);
    // Every allowlist row is still real (no stale rows).
    for (const a of ALIAS_ALLOW) {
      expect(
        found.some((f) => f.file === a.file && f.text === a.text),
        `${a.file}: ${a.text}`,
      ).toBe(true);
    }
  });

  it('the checker catches a .result read in a different function, and an alias', () => {
    const snippet = [
      'async function a() {',
      '  const backup = await backupCompose(ip);',
      '  return backup;',
      '}',
      'function b(backup) {',
      '  return backup.result;',
      '}',
    ].join('\n');
    expect(unconsumedCalls(snippet, RUNNERS)).toHaveLength(1);
    expect(aliasLines('x.js', 'const go = deps.backupCompose ?? backupCompose;')).toHaveLength(1);
    expect(aliasLines('x.js', 'const { triggerBackupJob: tj } = deps;')).toHaveLength(1);
    expect(aliasLines('x.js', '  backupCompose,')).toHaveLength(0);
  });

  it('parseBackupResult has one definition, and only it reads the marker', () => {
    const defs = srcFiles.filter((f) => /function parseBackupResult\(/.test(read(f)));
    expect(defs).toEqual(['src/lib/walg/backup-result.js']);
    const markerReaders = srcFiles.filter((f) => code(f).includes('BACKUP_RESULT'));
    expect(markerReaders).toEqual(['src/lib/walg/backup-result.js']);
  });
});
