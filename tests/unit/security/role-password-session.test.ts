/**
 * Census: a role password never rides in a statement Postgres can log.
 *
 * Postgres logs a failing statement's text (log_min_error_statement = error)
 * and any statement over a second (log_min_duration_statement = 1000), and the
 * db log reaches Loki with the observability add-on. A password literal in
 * such a statement is a secret in the logs. So any SQL in src/, carbon/ or
 * services/ that sets a role password must:
 *
 *   1. sit in a session that runs `SET log_min_error_statement = panic` and
 *      `SET log_min_duration_statement = -1` first (`SET LOCAL` counts), and
 *   2. not sit inside a DO block: an error raised in PL/pgSQL carries a
 *      CONTEXT line quoting the inner statement, literal included, which no
 *      SET suppresses.
 *
 * A "session" is the text since the last heredoc opener (shell) or the start
 * of the file (JS/TS). The replication role bit this on both HA tiers: compose
 * piped a DO block with the literal, and k8s rendered the same into
 * carbon/ha/primary-init.sql.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** `ALTER|CREATE ROLE|USER <name> ... PASSWORD <literal or variable>`; the match ends at the literal. */
const SETS_PASSWORD =
  /\b(?:ALTER|CREATE)\s+(?:ROLE|USER)\s+[\w${}.]+[^;]*?\bPASSWORD\s+(?=['$:]|E')/gi;
const SET_ERROR_STATEMENT = /\bSET\s+(?:LOCAL\s+)?log_min_error_statement\s*=\s*'?panic'?/i;
const SET_DURATION = /\bSET\s+(?:LOCAL\s+)?log_min_duration_statement\s*=\s*'?-1'?/i;

/** Why each password-setting statement in `text` can reach the log (empty when none can). */
function passwordLogRisks(text: string): string[] {
  const risks: string[] = [];
  for (const m of text.matchAll(SETS_PASSWORD)) {
    const end = (m.index ?? 0) + m[0].length;
    const before = text.slice(0, end);
    const session = before.slice(before.lastIndexOf('<<') + 1);
    const at = `near "${m[0].trim().slice(0, 40).replace(/\s+/g, ' ')}"`;
    if (!SET_ERROR_STATEMENT.test(session) || !SET_DURATION.test(session)) {
      risks.push(`${at}: the session does not run both log SETs first`);
    }
    if ((session.match(/\$\$/g) ?? []).length % 2 === 1) {
      risks.push(`${at}: the password is inside a DO block`);
    }
  }
  return risks;
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n === '.git') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const sources = ['src', 'carbon', 'services']
  .flatMap((d) => walk(join(ROOT, d)))
  .filter((p) => /\.(js|ts|sh|sql)$/.test(p))
  .filter((p) => !/\/(tests?|migrations)\//.test(p) && !/\.test\.[jt]s$/.test(p))
  .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf-8') }));

describe('census: a role password never rides in a loggable statement', () => {
  it('finds the role-password sites it is meant to police', () => {
    const sites = sources.filter(
      ({ text }) => passwordLogRisks(text).length === 0 && SETS_PASSWORD.test(text),
    );
    SETS_PASSWORD.lastIndex = 0;
    expect(sites.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        'src/lib/deploy/replication-slot.js',
        'carbon/src/server/db/app-service-role.ts',
        'services/observability/db/init.sh',
      ]),
    );
  });

  it('every one runs both log SETs first and stays out of a DO block', () => {
    const bad = sources.flatMap(({ path, text }) =>
      passwordLogRisks(text).map((r) => `${path} ${r}`),
    );
    expect(bad).toEqual([]);
  });

  describe('bites', () => {
    it('main compose/ha.js: a DO block carrying the literal, no SETs', () => {
      const old = `const createRoleSql = \`
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '\${replPassword}';
  ELSE
    ALTER ROLE replicator WITH PASSWORD '\${replPassword}';
  END IF;
END $$;\`;`;
      const risks = passwordLogRisks(old);
      expect(risks.some((r) => r.includes('both log SETs'))).toBe(true);
      expect(risks.some((r) => r.includes('DO block'))).toBe(true);
    });

    it('main carbon/ha/primary-init.sql: the same block with the placeholder', () => {
      const old = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '{{REPL_PASSWORD}}';
  END IF;
END $$;`;
      expect(passwordLogRisks(old).length).toBeGreaterThan(0);
    });

    it('SETs without the DO-block fix still fail, and a top-level ALTER after both SETs passes', () => {
      const sets = 'SET log_min_error_statement = panic;\nSET log_min_duration_statement = -1;\n';
      expect(
        passwordLogRisks(`${sets}DO $$ BEGIN ALTER ROLE r WITH PASSWORD 'x'; END $$;`),
      ).toHaveLength(1);
      expect(passwordLogRisks(`${sets}ALTER ROLE r WITH PASSWORD 'x';`)).toEqual([]);
      expect(passwordLogRisks("ALTER ROLE r WITH PASSWORD 'x';")).toHaveLength(1);
      expect(passwordLogRisks(`${sets}ALTER ROLE r WITH PASSWORD :'pw';`)).toEqual([]);
    });
  });
});
