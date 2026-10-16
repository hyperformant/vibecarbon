/**
 * Terminology census: the retired stack's vocabulary stays retired.
 *
 * Every mode runs your own Postgres 17, the Hono app with Better Auth and
 * Drizzle, and Traefik; extras arrive through `vibecarbon add`. The services
 * the old stack shipped (its API gateway, REST layer, auth server, pooler)
 * are gone, and so are their names. This census fails when one of those
 * names comes back in any file the repo carries: code, comments, test names,
 * fixtures, docs, the template that ships to users (carbon/**), the add-on
 * services (services/**), agent guidance (.claude/**, carbon/.claude/**,
 * carbon/.windsurfrules, carbon/.cursor/**). File PATHS count too, so a
 * renamed directory cannot carry the old name.
 *
 * Match rule: case-insensitive, and the term may not sit inside a longer
 * alphanumeric word (`hongkong` is fine, `SUPABASE_URL` and `gotrue-1` are
 * not, because `_` and `-` count as boundaries).
 *
 * Exemptions, kept minimal:
 *   - HISTORICAL: records of what happened, which must keep the names they
 *     happened under. CHANGELOG.md, docs/rca/**, docs/superpowers/plans/**,
 *     docs/superpowers/specs/**.
 *   - VENDORED: third-party text we do not edit. None today; an entry must
 *     name a real file.
 *   - LINES: one exact line per entry, for an external name the code must
 *     spell to talk to something outside this repo. Each must still match.
 *   - This file, which has to spell the terms to search for them.
 *
 * Scope: tracked files plus untracked files git does not ignore, so a new
 * file is caught before its first commit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SELF = 'tests/unit/lib/terminology-census.test.ts';

const TERMS = [
  'supabase',
  'gotrue',
  'postgrest',
  'kong',
  'supavisor',
  'anon_key',
  'service_role_key',
  'pgbouncer',
  'realtime_secret',
];
const TERM_RE = new RegExp(`(?<![a-z0-9])(?:${TERMS.join('|')})(?![a-z0-9])`, 'i');

const HISTORICAL_PREFIXES = [
  'CHANGELOG.md',
  'docs/rca/',
  'docs/superpowers/plans/',
  'docs/superpowers/specs/',
];
const VENDORED: string[] = [];

/** Exact lines allowed to carry a term, each with the reason it must. */
const LINES: { file: string; line: string; reason: string }[] = [
  {
    file: 'src/lib/deploy/k8s/k3s.js',
    line: "export const RETIRED_CHART_RELEASE = 'supabase'; // terminology-census: retired chart name",
    reason:
      'assertNoRetiredChartDb must name the old Helm release to find a chart-era cluster ' +
      'and refuse to deploy an empty database beside it (Task 12 ruling).',
  },
];

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|avif|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|br|wasm|mp4|webm|mov|db|sqlite)$/i;

type Source = { rel: string; text: string };

function isExempt(rel: string): boolean {
  return (
    rel === SELF || VENDORED.includes(rel) || HISTORICAL_PREFIXES.some((p) => rel.startsWith(p))
  );
}

/** Every `path` / `path:line: text` that carries a retired term. */
function offenders(sources: Source[]): string[] {
  const out: string[] = [];
  for (const { rel, text } of sources) {
    if (isExempt(rel)) continue;
    if (TERM_RE.test(rel)) out.push(`${rel} (path)`);
    const allowed = new Set(LINES.filter((l) => l.file === rel).map((l) => l.line));
    text.split('\n').forEach((line, i) => {
      if (!TERM_RE.test(line)) return;
      if (allowed.has(line.trim())) return;
      out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return out;
}

function repoFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(out.split('\0').filter(Boolean))];
}

function repoSources(): Source[] {
  const sources: Source[] = [];
  for (const rel of repoFiles()) {
    const abs = join(ROOT, rel);
    // A tracked file deleted in the working tree has nothing to scan.
    if (!existsSync(abs)) continue;
    if (BINARY_EXT.test(rel)) {
      sources.push({ rel, text: '' });
      continue;
    }
    const buf = readFileSync(abs);
    sources.push({ rel, text: buf.includes(0) ? '' : buf.toString('utf8') });
  }
  return sources;
}

describe('terminology census: the retired stack vocabulary', () => {
  it('no file outside the historical records names a retired service', () => {
    const found = offenders(repoSources());
    expect(
      found,
      'These name a service the stack no longer runs. Describe what runs now ' +
        '(Postgres, the app with Better Auth and Drizzle, Traefik, `vibecarbon add` ' +
        'extras), or move a genuine record of the past under docs/rca/.',
    ).toEqual([]);
  });

  it('every exemption still points at something real', () => {
    for (const p of VENDORED) expect(existsSync(join(ROOT, p)), p).toBe(true);
    for (const { file, line } of LINES) {
      const lines = readFileSync(join(ROOT, file), 'utf8')
        .split('\n')
        .map((l) => l.trim());
      expect(
        lines.filter((l) => l === line),
        `${file}: the exempt line is gone or duplicated`,
      ).toHaveLength(1);
      expect(TERM_RE.test(line), `${file}: the exempt line no longer needs exempting`).toBe(true);
    }
  });

  it('catches a planted hit and honors only the listed exemptions', () => {
    const planted = offenders([
      { rel: 'docs/technical.md', text: 'ok line\nThe Kong gateway routes /rest' },
      { rel: 'carbon/src/server/x.ts', text: 'const url = env.SUPABASE_URL;' },
      { rel: 'carbon/k8s/gitops/gotrue/kustomization.yaml', text: '' },
      { rel: 'src/lib/deploy/k8s/k3s.js', text: LINES[0].line },
      { rel: 'src/other.js', text: LINES[0].line },
      { rel: 'docs/rca/2026-01-01-x.md', text: 'PostgREST served a stale schema cache' },
      { rel: 'CHANGELOG.md', text: 'Removed Supavisor' },
      { rel: 'docs/places.md', text: 'hongkong, kongress, supabased are other words' },
    ]);
    expect(planted).toEqual([
      'docs/technical.md:2: The Kong gateway routes /rest',
      'carbon/src/server/x.ts:1: const url = env.SUPABASE_URL;',
      'carbon/k8s/gitops/gotrue/kustomization.yaml (path)',
      `src/other.js:1: ${LINES[0].line}`,
    ]);
  });
});
