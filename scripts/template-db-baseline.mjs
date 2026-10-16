#!/usr/bin/env node
/**
 * Regenerate the TEMPLATE's migration baseline (carbon/db/migrations) in
 * place: `pnpm template:db-baseline`. A vibecarbon maintainer tool; it lives
 * outside carbon/ so neither `vibecarbon create` nor `upgrade` ever puts it in
 * a project.
 *
 * The template ships exactly one baseline set in db/migrations/:
 *
 *   0000_baseline_pre.sql     custom: extensions, app_user, app schema,
 *                             the functions the policies call
 *   0001_baseline_schema.sql  generated from src/server/db/schema.ts
 *   0002_baseline_post.sql    custom: other functions, triggers, revokes,
 *                             pg_cron schedules, seed rows
 *   meta/                     drizzle-kit's journal and snapshots
 *
 * When the template schema changes, the baseline is regenerated, never
 * appended to: this keeps the two custom files' SQL, deletes the folder and
 * runs drizzle-kit three times in that order (`--custom` takes the previous
 * snapshot, so the first custom file has an empty one and the generated file
 * holds the whole schema), then writes the custom SQL back.
 *
 * A generated project never does this: once created, its db/migrations is its
 * own history and grows with `npx drizzle-kit generate` (AGENTS.md).
 *
 * Afterwards: run the carbon db tier; tests/db/migrations.test.ts compares
 * the migrated catalog with tests/db/fixtures/baseline-catalog.json
 * (UPDATE_CATALOG_FIXTURE=1 to accept an intended change).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'carbon');
const dir = join(root, 'db', 'migrations');

/** The baseline set, in journal order. `custom` files keep their SQL. */
export const BASELINE = [
  { tag: '0000_baseline_pre', name: 'baseline_pre', custom: true },
  { tag: '0001_baseline_schema', name: 'baseline_schema', custom: false },
  { tag: '0002_baseline_post', name: 'baseline_post', custom: true },
];

function drizzleKit(args) {
  const res = spawnSync(join(root, 'node_modules', '.bin', 'drizzle-kit'), ['generate', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.error(`drizzle-kit generate ${args.join(' ')} failed`);
    process.exit(res.status ?? 1);
  }
}

function main() {
  const kept = new Map();
  for (const { tag, custom } of BASELINE) {
    if (!custom) continue;
    const file = join(dir, `${tag}.sql`);
    if (!existsSync(file)) {
      console.error(`Missing ${file}; restore it from git before regenerating.`);
      process.exit(1);
    }
    kept.set(tag, readFileSync(file, 'utf8'));
  }
  rmSync(dir, { recursive: true, force: true });
  for (const { name, custom } of BASELINE) {
    drizzleKit([...(custom ? ['--custom'] : []), `--name=${name}`]);
  }
  for (const [tag, sql] of kept) writeFileSync(join(dir, `${tag}.sql`), sql);
  console.log(
    'Baseline regenerated. Every migration timestamp changed, so a dev database migrated with ' +
      'the previous baseline will try to apply it again and fail: reset existing dev volumes ' +
      '(npm run dev:reset in carbon/ or a project) before starting the app. Then run the ' +
      'carbon db tier (tests/db/migrations.test.ts) against a fresh database.',
  );
}

if (process.argv[1] && process.argv[1].endsWith('template-db-baseline.mjs')) main();
