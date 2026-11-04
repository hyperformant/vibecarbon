/**
 * Postgres writes its server log at the default level (warning) in every mode.
 *
 * The db command used to pass `-c log_min_messages=fatal` (compose and the k8s
 * StatefulSet alike), an override inherited from the original template.
 * Postgres orders server-log levels ... WARNING, ERROR, LOG, FATAL, PANIC, so
 * `fatal` dropped every ERROR, every WARNING and every LOG line. That silently disabled the slow
 * statement and lock-wait logging the baked postgresql.conf turns on (both are
 * LOG lines), and it hid why a standby stopped when its primary moved to a new
 * timeline (2026-11-04, DO k8s-ha restore): the log said nothing at all.
 *
 * The census walks every compose file, k8s manifest and postgresql.conf the
 * template and the db image ship, so a new one cannot bring the override back.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const SCAN_DIRS = ['carbon', 'docker', 'services'];
const SKIP = new Set(['node_modules', 'dist', '.git']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ya?ml|conf)$/.test(name) ? [p] : [];
  });
}

/** A log_min_messages setting quieter than the default: error, log, fatal or panic. */
const QUIET = /log_min_messages\s*[=:]?\s*['"]?(error|log|fatal|panic)\b/i;

describe('Postgres server log level', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

  it('scans the compose files, the k8s db StatefulSet and the baked postgresql.conf', () => {
    const names = files.map((f) => relative(ROOT, f));
    expect(names).toContain('carbon/docker-compose.yml');
    expect(names).toContain('carbon/k8s/base/db/statefulset.yaml');
    expect(names).toContain('docker/postgres-walg/postgresql.conf');
  });

  it('nothing sets log_min_messages above the default (warning)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          if (QUIET.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('the census catches the override in either spelling', () => {
    expect(QUIET.test('      - log_min_messages=fatal')).toBe(true);
    expect(QUIET.test("log_min_messages = 'error'")).toBe(true);
    expect(QUIET.test('log_min_messages: panic')).toBe(true);
    expect(QUIET.test('log_min_messages = warning')).toBe(false);
  });

  it('the slow-statement and lock-wait lines it would have hidden stay on', () => {
    const conf = readFileSync(join(ROOT, 'docker/postgres-walg/postgresql.conf'), 'utf-8');
    expect(conf).toMatch(/^log_min_duration_statement = 1000$/m);
    expect(conf).toMatch(/^log_lock_waits = on$/m);
  });
});
