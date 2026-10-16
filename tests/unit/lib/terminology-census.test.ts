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
 * Match rule, built so camelCase and SCREAMING_CASE identifiers cannot hide
 * a term (`createSupabaseClient`, `gotrueUrl`, `anonKey`, `serviceRoleKey`,
 * `SUPABASE_URL` all hit):
 *   - supabase, gotrue, postgrest, supavisor, pgbouncer: matched anywhere,
 *     case-insensitive. They are distinctive enough that no English word or
 *     unrelated identifier contains them.
 *   - anon key, service role key, realtime secret: matched anywhere,
 *     case-insensitive, with an optional `_`/`-` between the parts. `anonkey`
 *     is not matched right after a `c` (`canonKey`).
 *   - kong: a short word that real words contain (`Hongkong`, `kongsberg`),
 *     so it needs a boundary that still understands camelCase. Three rules:
 *     (a) case-insensitive `kong` with no letter or digit before it and no
 *     letter after it (`kong`, `KONG_URL`, `kong-proxy`); (b) case-sensitive
 *     `Kong` with no lowercase letter after it (`KongPlugin`, `getKong`,
 *     `useKong()`); (c) case-sensitive `kong` with no letter or digit before
 *     it and an uppercase letter after it (`kongPlugin`). `Hongkong` and
 *     `kongsberg` pass every rule (a lowercase letter follows); `HongKong`
 *     would hit rule (b), an accepted false positive.
 *
 * Not enforced, on purpose: `service_role` (the secret scanner's JWT claim
 * check and the RLS foreign-role test name it legitimately), `studio`
 * (Drizzle Studio is a real tool here, and a future add-on may be one),
 * `pooler` and `realtime` (ordinary words; a future `vibecarbon add
 * realtime` would use the second). Their stale product uses were swept by
 * hand.
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

const TERM_PATTERNS = [
  /supabase|gotrue|postgrest|supavisor|pgbouncer/i,
  /(?<!c)anon[_-]?key|service[_-]?role[_-]?key|realtime[_-]?secret/i,
  /(?<![a-z0-9])kong(?![a-z])/i,
  /Kong(?![a-z])/,
  /(?<![A-Za-z0-9])kong(?=[A-Z])/,
];
const hasTerm = (text: string) => TERM_PATTERNS.some((re) => re.test(text));

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
    if (hasTerm(rel)) out.push(`${rel} (path)`);
    const allowed = new Set(LINES.filter((l) => l.file === rel).map((l) => l.line));
    text.split('\n').forEach((line, i) => {
      if (!hasTerm(line)) return;
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
      expect(hasTerm(line), `${file}: the exempt line no longer needs exempting`).toBe(true);
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
      {
        rel: 'docs/places.md',
        text: 'Hongkong, hongkong, kongress, kongsberg, canonKey are other words',
      },
      { rel: 'carbon/src/a.ts', text: 'const c = createSupabaseClient(url);' },
      { rel: 'carbon/src/b.ts', text: 'type P = KongPlugin; const g = gotrueUrl;' },
      { rel: 'carbon/src/c.ts', text: 'const k = { anonKey, serviceRoleKey };' },
      { rel: 'carbon/src/d.ts', text: 'getK8sSupabaseUserData(); kongPlugin(); SupabaseProvider' },
      { rel: 'carbon/src/e.ts', text: 'REALTIME_SECRET=x KONG_URL=y' },
    ]);
    expect(planted).toEqual([
      'docs/technical.md:2: The Kong gateway routes /rest',
      'carbon/src/server/x.ts:1: const url = env.SUPABASE_URL;',
      'carbon/k8s/gitops/gotrue/kustomization.yaml (path)',
      `src/other.js:1: ${LINES[0].line}`,
      'carbon/src/a.ts:1: const c = createSupabaseClient(url);',
      'carbon/src/b.ts:1: type P = KongPlugin; const g = gotrueUrl;',
      'carbon/src/c.ts:1: const k = { anonKey, serviceRoleKey };',
      'carbon/src/d.ts:1: getK8sSupabaseUserData(); kongPlugin(); SupabaseProvider',
      'carbon/src/e.ts:1: REALTIME_SECRET=x KONG_URL=y',
    ]);
  });

  it('each match rule catches its own spellings and spares look-alike words', () => {
    const hits = [
      'createSupabaseClient',
      'SupabaseProvider',
      'getK8sSupabaseUserData',
      'SUPABASE_URL',
      'gotrueUrl',
      'PostgRESTError',
      'supavisorPool',
      'PGBOUNCER_HOST',
      'anonKey',
      'ANON_KEY',
      'anon-key',
      'serviceRoleKey',
      'SERVICE_ROLE_KEY',
      'realtimeSecret',
      'REALTIME_SECRET',
      'kong',
      'KONG_URL',
      'kong-proxy',
      'KongPlugin',
      'getKong()',
      'kongPlugin',
      'the Kong gateway',
    ];
    const spared = [
      'Hongkong',
      'hongkong',
      'kongsberg',
      'Kongsberg',
      'KONGSBERG',
      'canonKey',
      'service_role',
    ];
    expect(hits.filter((t) => !hasTerm(t))).toEqual([]);
    expect(spared.filter((t) => hasTerm(t))).toEqual([]);
  });
});
