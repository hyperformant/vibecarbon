/**
 * Every psql / pg_isready we run names its role.
 *
 * The db image is postgres:17-alpine, whose only superuser is `postgres`. A
 * client started with no `-U` inside `docker compose exec db` / `kubectl exec`
 * runs as the container's OS user, root, and the server logs
 * `FATAL: role "root" does not exist` for every probe (pg_isready included: it
 * never authenticates, but the server still rejects the unknown role and logs
 * it). A retired role name fails the same way. So every invocation in the
 * shipped code carries an explicit `-U`/`--username` and names a role that
 * exists: postgres, replicator, or the entrypoint's $POSTGRES_USER.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FILES = execFileSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'src/*.js', // git pathspec `*` crosses `/`: this is recursive
    'carbon/backup/*.sh',
    'carbon/volumes/db/*.sh',
    'carbon/k8s/*.yaml',
    'carbon/docker-compose*.yml',
    'carbon/scripts/*.js',
    'services/*/db/*.sh',
    'services/*/compose/*.yml',
    'tests/e2e/*.ts',
  ],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean);

/** A command-position psql/pg_isready: shell text or a quoted argv element. */
const INVOCATION = /(?:^|[\s"'`(|;&])(psql|pg_isready)(?=\s+-|\s*['"`],?\s*$|\s*$|["'],\s)/;
const ROLE = /(?:-U|--username)[\s'",=]+(?:\n\s*['"])?([$\w{}:-]+)/;
// The last entry is shell text, not a JS template.
const ALLOWED = new Set(['postgres', 'replicator', '$POSTGRES_USER', '$' + '{PGUSER:-postgres}']);

function sites() {
  const out: Array<{ where: string; role: string | null }> = [];
  for (const rel of FILES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return;
      if (!INVOCATION.test(line)) return;
      // argv arrays spread the flags over the following lines.
      const window = lines.slice(i, i + 12).join('\n');
      const m = window.match(ROLE);
      out.push({ where: `${rel}:${i + 1}`, role: m ? m[1].replace(/["']/g, '') : null });
    });
  }
  return out;
}

describe('db client role census', () => {
  const found = sites();

  it('finds the invocations it audits (a moved directory must not empty it)', () => {
    expect(found.length).toBeGreaterThan(30);
  });

  it('sees the argv-array shape (flags on the following lines)', () => {
    expect(found.some(({ where }) => where.startsWith('src/failover.js:'))).toBe(true);
  });

  it('every psql / pg_isready names an existing role', () => {
    const bad = found
      .filter(({ role }) => role === null || !ALLOWED.has(role))
      .map(({ where, role }) => `${where}: ${role ?? '(no -U)'}`);
    expect(bad).toEqual([]);
  });
});
