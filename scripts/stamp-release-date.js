#!/usr/bin/env node
/**
 * Stamp today's UTC date into the working tree's package.json, immediately
 * before publish.
 *
 * `.github/workflows/release.yml` runs this AFTER `pnpm install` and BEFORE
 * `pnpm exec semantic-release` — semantic-release's npm plugin publishes
 * whatever is on disk at that point, so the resulting dirty `package.json`
 * is intentional and is never committed. `src/lib/licensing/release-date.js`
 * reads the `releaseDate` key this writes as the first (and normal) branch
 * of its resolution order.
 *
 * The committed package.json must NEVER carry this key — a stale stamp in a
 * dev checkout would make `getReleaseDate()` report a fixed date forever
 * instead of falling through to HEAD's commit date.
 *
 * Usage:
 *   node scripts/stamp-release-date.js                  # stamps today (UTC)
 *   node scripts/stamp-release-date.js -date 2026-09-12  # override, for tests only
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateFlag(argv) {
  const i = argv.indexOf('-date');
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || !DATE_RE.test(value)) {
    console.error(`-date must be YYYY-MM-DD, got: ${value ?? '<missing>'}`);
    process.exit(1);
  }
  return value;
}

const today = parseDateFlag(process.argv.slice(2)) ?? new Date().toISOString().slice(0, 10);

const pkgPath = join(process.cwd(), 'package.json');
const raw = readFileSync(pkgPath, 'utf-8');
const pkg = JSON.parse(raw);

if (pkg.releaseDate && pkg.releaseDate !== today) {
  console.error(
    `package.json already has releaseDate "${pkg.releaseDate}", which does not match today's UTC date "${today}". Refusing to overwrite — this step should only ever run once, right before publish.`,
  );
  process.exit(1);
}

pkg.releaseDate = today;

const stamped = `${JSON.stringify(pkg, null, 2)}${raw.endsWith('\n') ? '\n' : ''}`;
writeFileSync(pkgPath, stamped);

console.log(pkg.releaseDate);
