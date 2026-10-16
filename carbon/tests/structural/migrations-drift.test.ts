import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * src/server/db/schema.ts and db/migrations/ agree: running
 * `drizzle-kit generate` against a copy of the committed migrations writes
 * nothing. When this fails, schema.ts has a change no migration carries yet:
 * run `npx drizzle-kit generate --name <slug>` and commit the new file
 * (AGENTS.md "Changing the database schema").
 *
 * No database needed: drizzle-kit compares schema.ts with the last snapshot
 * in db/migrations/meta.
 */

const ROOT = join(__dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'migrations-drift-'));

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('migrations drift', () => {
  it('drizzle-kit generate finds no pending schema change', () => {
    const out = join(work, 'migrations');
    cpSync(join(ROOT, 'db', 'migrations'), out, { recursive: true });
    const before = readdirSync(out).sort();
    const bin = join(ROOT, 'node_modules', '.bin', 'drizzle-kit');
    const log = execFileSync(
      bin,
      [
        'generate',
        '--dialect',
        'postgresql',
        '--schema',
        './src/server/db/schema.ts',
        // drizzle-kit resolves --out against the working directory.
        '--out',
        relative(ROOT, out),
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const added = readdirSync(out)
      .sort()
      .filter((f) => !before.includes(f));
    expect(added, `schema.ts has changes without a migration:\n${log}`).toEqual([]);
    expect(log).toContain('No schema changes');
  }, 60_000);
});
