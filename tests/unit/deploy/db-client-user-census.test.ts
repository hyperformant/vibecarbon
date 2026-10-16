/**
 * Every Postgres client we run (psql, pg_isready, pg_basebackup, pg_dump,
 * pg_restore) names its role.
 *
 * The db image is postgres:17-alpine, whose only superuser is `postgres`. A
 * client started with no `-U` inside `docker compose exec db` / `kubectl exec`
 * runs as the container's OS user, root, and the server logs
 * `FATAL: role "root" does not exist` for every probe (pg_isready included: it
 * never authenticates, but the server still rejects the unknown role and logs
 * it). A retired role name fails the same way. So every invocation in the
 * shipped code carries an explicit `-U`/`--username` and names a role that
 * exists: postgres or replicator, directly or through a shell variable whose
 * value resolves to one (n8n's setup.sh connects as its own `n8n` role).
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
    'services/*/scripts/*.sh',
    'carbon/volumes/n8n/scripts/setup.sh',
    'tests/e2e/*.ts',
  ],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean);

const CLIENTS = 'psql|pg_isready|pg_basebackup|pg_dump|pg_restore';
/** A command-position client: shell text or a quoted argv element. */
const INVOCATION = new RegExp(
  `(?:^|[\\s"'\`(|;&])(${CLIENTS})(?=\\s+[-|;&\\\\]|\\s*['"\`],?\\s*$|\\s*$|["'],\\s)`,
  'g',
);
const ROLE = /(?:-U|--username)[\s'",=]+([$\w{}:-]+)/;
/** Shell separators that end one command and start the next. */
const SEPARATOR = /&&|\|\||;|\|/;
// n8n is the role carbon/volumes/db/n8n-init.sh creates for n8n's own database.
const ALLOWED = new Set(['postgres', 'replicator', 'n8n']);

/**
 * The text of the ONE command starting at `col` on line `i`: the rest of the
 * line, plus continuation lines (a trailing `\`, or `\\` inside a JS template)
 * or, for an argv element (`'psql',`), the following elements up to the
 * closing `]`. Shell text is then cut at the first separator, so a later
 * command's `-U` can never be credited to this one.
 */
function commandText(lines: string[], i: number, col: number): string {
  let text = lines[i].slice(col);
  const argv = /^['"`]?\w+['"`],\s*$/.test(text.trim());
  if (argv) {
    for (let k = i + 1; k < lines.length && !/^\s*\]/.test(lines[k]); k++) text += `\n${lines[k]}`;
    return text;
  }
  for (let k = i; /\\\s*$/.test(lines[k]) && k + 1 < lines.length; k++) text += `\n${lines[k + 1]}`;
  const name = text.match(new RegExp(CLIENTS))?.[0] ?? '';
  const rest = text.slice(text.indexOf(name) + name.length);
  return name + rest.split(SEPARATOR)[0];
}

/**
 * Resolve a role token to a literal: `postgres` as is, `${VAR:-x}` to x, and
 * `$VAR` / `"$VAR"` through the file's own `VAR=...` assignment (whose
 * `${OTHER:-x}` default is resolved the same way). $POSTGRES_USER is the
 * official entrypoint's user, set to postgres in docker-compose.yml.
 */
function resolveRole(token: string, file: string): string | null {
  const t = token.replace(/["']/g, '');
  if (t === '$POSTGRES_USER') return 'postgres';
  const dflt = t.match(/^\$\{\w+:-([\w-]+)\}$/);
  if (dflt) return dflt[1];
  const v = t.match(/^\$\{?(\w+)\}?$/);
  if (v) {
    const assign = file.match(new RegExp(`^\\s*${v[1]}="?([^"\\n]+)"?\\s*$`, 'm'));
    return assign ? resolveRole(assign[1], file) : null;
  }
  return t;
}

function sitesIn(rel: string, file: string) {
  const out: Array<{ where: string; role: string | null }> = [];
  const lines = file.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return;
    for (const m of line.matchAll(INVOCATION)) {
      const cmd = commandText(lines, i, (m.index ?? 0) + m[0].indexOf(m[1]));
      const role = cmd.match(ROLE);
      out.push({ where: `${rel}:${i + 1}`, role: role ? resolveRole(role[1], file) : null });
    }
  });
  return out;
}

const sites = () => FILES.flatMap((rel) => sitesIn(rel, readFileSync(join(ROOT, rel), 'utf8')));

describe('db client role census', () => {
  const found = sites();

  it('finds the invocations it audits (a moved directory must not empty it)', () => {
    expect(found.length).toBeGreaterThan(30);
  });

  it('sees the argv-array shape (flags on the following lines)', () => {
    expect(found.some(({ where }) => where.startsWith('src/failover.js:'))).toBe(true);
    // ...and the service scripts that connect as their own role.
    expect(
      found.filter(({ where }) => where.startsWith('carbon/volumes/n8n/scripts/setup.sh:')),
    ).toEqual([expect.objectContaining({ role: 'n8n' }), expect.objectContaining({ role: 'n8n' })]);
  });

  it('every db client names an existing role', () => {
    const bad = found
      .filter(({ role }) => role === null || !ALLOWED.has(role))
      .map(({ where, role }) => `${where}: ${role ?? '(no -U)'}`);
    expect(bad).toEqual([]);
  });

  it('covers every client and resolves shell variables to their role', () => {
    const shell = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell source text
      'DB_USER="${N8N_DB_USER:-n8n}"',
      'psql -h db -U "$DB_USER" -d n8n',
      'pg_dump -U postgres app > /tmp/a.sql',
      'pg_restore --username=postgres -d app /tmp/a.dump',
      'PGPASSWORD=x pg_basebackup \\',
      '  -h 10.0.0.1 -p 5433 \\',
      '  -U replicator -D /tmp/s',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell source text
      'psql -U "${PGUSER:-postgres}" -c "SELECT 1"',
    ].join('\n');
    expect(sitesIn('probe.sh', shell).map(({ role }) => role)).toEqual([
      'n8n',
      'postgres',
      'postgres',
      'replicator',
      'postgres',
    ]);
  });

  it('never credits a later command with the -U it lacks', () => {
    const shell = [
      'pg_isready -h localhost && psql -U postgres -c "SELECT 1"',
      'docker compose exec -T db pg_isready | grep ok; pg_dump -U postgres app',
    ].join('\n');
    expect(sitesIn('probe.sh', shell)).toEqual([
      { where: 'probe.sh:1', role: null },
      { where: 'probe.sh:1', role: 'postgres' },
      { where: 'probe.sh:2', role: null },
      { where: 'probe.sh:2', role: 'postgres' },
    ]);
    const argv = [
      "  'pg_isready',",
      "  '-h',",
      "  '127.0.0.1',",
      '];',
      "run(['psql', '-U', 'x']);",
    ];
    expect(sitesIn('probe.js', argv.join('\n'))[0]).toEqual({ where: 'probe.js:1', role: null });
  });
});
