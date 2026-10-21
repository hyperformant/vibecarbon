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

const CALL = /\b(backupCompose|triggerBackupJob)\(/g;

type Site = { file: string; line: number; text: string };

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const file of srcFiles) {
    const lines = read(file).split('\n');
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      if (/function (backupCompose|triggerBackupJob)\(/.test(text)) return;
      if (!CALL.test(text)) return;
      CALL.lastIndex = 0;
      sites.push({ file, line: i + 1, text });
    });
  }
  return sites;
}

describe('backup results are consumed', () => {
  const sites = callSites();

  it('finds the known call sites (backup create, destroy, scale)', () => {
    const files = [...new Set(sites.map((s) => s.file))].sort();
    expect(files).toEqual(['src/backup.js', 'src/destroy.js', 'src/scale.js']);
  });

  it.each(sites.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s reads .result',
    (_at, site) => {
      const destructured =
        /\{[^}]*\bresult\b[^}]*\}\s*=\s*await\s+(backupCompose|triggerBackupJob)\(/;
      const bound = /\b(\w+)\s*=\s*await\s+(?:backupCompose|triggerBackupJob)\(/.exec(site.text);
      const ok =
        destructured.test(site.text) ||
        (bound !== null && new RegExp(`\\b${bound[1]}\\.result\\b`).test(read(site.file)));
      expect(ok, `${site.file}:${site.line} ignores the backup result: ${site.text.trim()}`).toBe(
        true,
      );
    },
  );

  it('parseBackupResult has one definition, and only it reads the marker', () => {
    const defs = srcFiles.filter((f) => /function parseBackupResult\(/.test(read(f)));
    expect(defs).toEqual(['src/lib/walg/backup-result.js']);
    const markerReaders = srcFiles.filter((f) => code(f).includes('BACKUP_RESULT'));
    expect(markerReaders).toEqual(['src/lib/walg/backup-result.js']);
  });
});
