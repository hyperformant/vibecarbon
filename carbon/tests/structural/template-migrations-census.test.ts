import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TEMPLATE ONLY. `vibecarbon create` does not copy this file: a generated
 * project's db/migrations is its own history and grows with every
 * `drizzle-kit generate`, which this census would reject.
 *
 * The template ships exactly ONE baseline set, regenerated in place when the
 * template schema changes (`pnpm template:db-baseline` in the vibecarbon
 * repo root), never appended to:
 *
 *   0000_baseline_pre.sql     custom: extensions, app_user, app schema,
 *                             the functions the policies call
 *   0001_baseline_schema.sql  generated from src/server/db/schema.ts
 *   0002_baseline_post.sql    custom: the rest (triggers, revokes, cron, seeds)
 *   meta/                     drizzle-kit's journal + one snapshot each
 *
 * Whether schema.ts has an ungenerated change is migrations-drift.test.ts.
 */

const DIR = join(__dirname, '..', '..', 'db', 'migrations');
const TAGS = ['0000_baseline_pre', '0001_baseline_schema', '0002_baseline_post'];

describe('template migrations census', () => {
  it('db/migrations holds the baseline set and drizzle meta, nothing else', () => {
    expect(readdirSync(DIR).sort()).toEqual([...TAGS.map((t) => `${t}.sql`), 'meta']);
    expect(readdirSync(join(DIR, 'meta')).sort()).toEqual([
      '0000_snapshot.json',
      '0001_snapshot.json',
      '0002_snapshot.json',
      '_journal.json',
    ]);
  });

  it('the journal lists the baseline in order', () => {
    const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.map((e) => e.tag)).toEqual(TAGS);
    expect(journal.entries.map((e) => e.idx)).toEqual([0, 1, 2]);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });

  it('the custom halves are filled in and the generated half is not hand-edited', () => {
    for (const tag of ['0000_baseline_pre', '0002_baseline_post']) {
      const sql = readFileSync(join(DIR, `${tag}.sql`), 'utf8');
      expect(sql, `${tag}.sql is still drizzle-kit's empty custom file`).not.toContain(
        'Custom SQL migration file, put your code below!'
      );
    }
    // drizzle-kit writes no comments into a generated migration; a comment
    // there means someone edited it by hand (regenerate instead).
    const generated = readFileSync(join(DIR, '0001_baseline_schema.sql'), 'utf8');
    expect(generated).not.toMatch(/^--(?!> statement-breakpoint)/m);
  });
});
