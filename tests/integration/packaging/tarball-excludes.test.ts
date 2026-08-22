import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Behavioral guard for the npm tarball (blocker #9, 2026-08-08 pre-launch audit).
 *
 * `.npmignore` overrides `.gitignore` per-directory, so a git-ignored dev file
 * under `carbon/` (which is in package.json `files`) would be PACKED unless
 * `carbon/.npmignore` excludes it. This test drops sentinel files matching each
 * exclusion class, runs the real `npm pack --dry-run`, and asserts none of them
 * ship — so it catches a regression regardless of which real dev artifacts
 * (e.g. a developer's actual carbon/.env.local) happen to exist at test time.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// path -> whether we created its parent dir (so cleanup only removes what we made)
const sentinels: { path: string; createdDir?: string }[] = [
  { path: join(repoRoot, 'carbon', '.env.launchtest-sentinel') },
  { path: join(repoRoot, 'carbon', 'launchtest-sentinel.generated.sql') },
  {
    path: join(repoRoot, 'carbon', '.claude', 'agent-memory', 'launchtest-sentinel.md'),
    createdDir: join(repoRoot, 'carbon', '.claude', 'agent-memory'),
  },
];

beforeAll(() => {
  for (const s of sentinels) {
    if (s.createdDir && !existsSync(s.createdDir)) {
      mkdirSync(s.createdDir, { recursive: true });
    }
    writeFileSync(s.path, 'launchtest sentinel — safe to delete\n');
  }
});

afterAll(() => {
  for (const s of sentinels) {
    rmSync(s.path, { force: true });
    // Only remove the agent-memory dir if it was empty apart from our sentinel
    // and we are confident we created it (best-effort; never throw in cleanup).
    if (s.createdDir) {
      try {
        rmSync(s.createdDir, { recursive: false });
      } catch {
        /* dir not empty or pre-existing — leave it */
      }
    }
  }
});

function packedFiles(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out) as unknown;
  // npm <=11 returns an array `[{ files: [...] }]`; npm 12+ returns an object
  // keyed by package name `{ vibecarbon: { files: [...] } }`. Handle both.
  const entry = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as Record<string, unknown>)[0]
  ) as { files?: Array<{ path: string }> } | undefined;
  const files = (entry?.files ?? []).map((f) => f.path);
  // Fail loud on a format/parse mismatch so the leak check can never pass vacuously.
  if (files.length === 0) {
    throw new Error(
      'npm pack --dry-run --json returned no files — parser/format mismatch, not an empty package',
    );
  }
  return files;
}

describe('npm tarball excludes dev artifacts', () => {
  it('never ships .env files, agent-memory, generated SQL, or dev-init', () => {
    const files = packedFiles();

    const forbidden = files.filter(
      (p) =>
        /(^|\/)\.env(\.(?!example)[^/]*)?$/.test(p) || // .env or .env.* except .env.example
        /(^|\/)\.claude\/agent-memory\//.test(p) ||
        /\.generated\.sql$/.test(p) ||
        /(^|\/)docker-compose\.dev-init\.yml$/.test(p),
    );

    expect(forbidden, `tarball leaked dev artifacts:\n${forbidden.join('\n')}`).toEqual([]);
  });

  it('still ships the intended .env.example', () => {
    const files = packedFiles();
    expect(files.some((p) => p.endsWith('carbon/.env.example'))).toBe(true);
  });
});
