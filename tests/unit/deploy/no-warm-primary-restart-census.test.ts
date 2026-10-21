/**
 * Census: a deploy never restarts the serving primary database
 * (HA-correctness Task 8, M1).
 *
 * Every HA deploy used to restart the live primary: it ran
 * `ALTER SYSTEM SET wal_level/max_wal_senders/wal_keep_size`, then bounced the
 * database to load them (compose `restart db`, k8s `delete pod db-0` plus an
 * app rollout restart). That was a leftover from the old db image, whose
 * postgres started without replication settings. Our db argv now carries
 * them on the command line (carbon/docker-compose.yml, the db StatefulSet), so
 * the settings are live from the first boot and a deploy only reloads
 * (pg_hba, the replicator role, the slot).
 *
 * Rules:
 *   (a) no string in src/lib/deploy/compose/ or src/lib/deploy/k8s/ha/ (the
 *       deploy, reconverge and failover code of both HA tiers) restarts the db
 *       container or deletes the db pod, with an allowlist of zero. The scale
 *       path (src/scale.js) only force-recreates a brand-new server.
 *   (b) carbon/ha/primary-init.sql carries no ALTER SYSTEM for any setting the
 *       db argv already sets, and both argv lists carry the replication
 *       startup flags.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const DIRS = ['src/lib/deploy/compose', 'src/lib/deploy/k8s/ha'];

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst / parsed YAML.
type Node = any;

/** Shapes that bounce the db: `compose restart db`, `delete pod <db pod>`, a statefulset rollout restart. */
const RESTART_SHAPES = [
  /\brestart\s+db\b/,
  // Any pod delete but the legacy bare repl-gateway Pod's (final review M6:
  // a socat relay, never the db; removed once so its Deployment can bind).
  /\bdelete\s+pod\b(?!\s+repl-gateway\s)/,
  /\brollout\s+restart\s+(statefulset|sts)\b/,
];

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? jsFiles(path) : path.endsWith('.js') ? [path] : [];
  });
}

/** The text of every string and template literal in a source file (comments excluded). */
function stringsOf(source: string): string[] {
  const out: string[] = [];
  const visit = (node: Node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
    if (node.type === 'TemplateLiteral') {
      out.push(node.quasis.map((q: Node) => q.value.cooked ?? '').join('<expr>'));
    }
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'type' && k !== 'start' && k !== 'end') visit(v);
    }
  };
  visit(parseAst(source));
  return out;
}

/** `file: shape` for each db-bouncing string in a source. */
function restartsIn(file: string, source: string): string[] {
  return stringsOf(source).flatMap((text) =>
    RESTART_SHAPES.filter((re) => re.test(text)).map(
      (re) => `${file}: ${re} in "${text.slice(0, 80)}"`,
    ),
  );
}

describe('census (a): no deploy-side db restart', () => {
  it('scans the deploy sources', () => {
    const files = DIRS.flatMap((d) => jsFiles(join(REPO, d)));
    expect(files.length).toBeGreaterThan(5);
  });

  it('nothing under compose/ or k8s/ha/ restarts the db or deletes its pod', () => {
    const found = DIRS.flatMap((d) => jsFiles(join(REPO, d))).flatMap((f) =>
      restartsIn(relative(REPO, f), readFileSync(f, 'utf-8')),
    );
    expect(found).toEqual([]);
  });

  it('bites: each restart shape is reported', () => {
    expect(restartsIn('x.js', 'const c = `cd \x24{d} && docker compose restart db`;')).toHaveLength(
      1,
    );
    expect(
      restartsIn('x.js', 'run(`kubectl delete pod \x24{DB_POD} -n vibecarbon`);'),
    ).toHaveLength(1);
    expect(restartsIn('x.js', "run('kubectl rollout restart statefulset/db');")).toHaveLength(1);
    expect(restartsIn('x.js', '// docker compose restart db\nconst a = 1;')).toEqual([]);
  });
});

/** `-c key=value` pairs of a postgres argv, as a map. */
function argvSettings(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  argv.forEach((tok, i) => {
    if (tok !== '-c') return;
    const [key, ...rest] = String(argv[i + 1] ?? '').split('=');
    out[key] = rest.join('=');
  });
  return out;
}

const composeArgv = (): string[] =>
  (loadAll(readFileSync(join(REPO, 'carbon/docker-compose.yml'), 'utf-8')) as Node[])[0].services.db
    .command;
const k8sArgv = (): string[] => {
  const sts = (
    loadAll(readFileSync(join(REPO, 'carbon/k8s/base/db/statefulset.yaml'), 'utf-8')) as Node[]
  ).find((d) => d?.kind === 'StatefulSet');
  return sts.spec.template.spec.containers.find((c: Node) => c.name === 'db').args;
};

/** Settings an `ALTER SYSTEM SET` in the SQL would persist. */
function alterSystemSettings(sql: string): string[] {
  return [...sql.matchAll(/^\s*ALTER\s+SYSTEM\s+SET\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
}

/** The ALTER SYSTEM settings in `sql` that the argv already sets. */
function shadowedByArgv(sql: string, argv: string[]): string[] {
  const set = argvSettings(argv);
  return alterSystemSettings(sql).filter((key) => key in set);
}

const REPLICATION_STARTUP_FLAGS = ['wal_level', 'hot_standby', 'max_wal_senders', 'wal_keep_size'];

describe('census (b): replication settings live in the db argv, not in ALTER SYSTEM', () => {
  const sql = readFileSync(join(REPO, 'carbon/ha/primary-init.sql'), 'utf-8');

  it('both db argv lists carry the replication startup flags', () => {
    for (const argv of [composeArgv(), k8sArgv()]) {
      const set = argvSettings(argv);
      expect(REPLICATION_STARTUP_FLAGS.filter((k) => !(k in set))).toEqual([]);
    }
  });

  it('primary-init.sql sets nothing the k8s db args already set', () => {
    expect(shadowedByArgv(sql, k8sArgv())).toEqual([]);
  });

  it('primary-init.sql sets nothing the compose db command already sets', () => {
    expect(shadowedByArgv(sql, composeArgv())).toEqual([]);
  });

  it('bites: an ALTER SYSTEM for an argv setting is reported', () => {
    expect(shadowedByArgv('ALTER SYSTEM SET max_wal_senders = 5;', k8sArgv())).toEqual([
      'max_wal_senders',
    ]);
    expect(shadowedByArgv('SELECT pg_reload_conf();', k8sArgv())).toEqual([]);
  });
});
