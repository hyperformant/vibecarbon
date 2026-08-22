/**
 * Repo-wide tripwire for the truncated-listing failure class (2026-07-30).
 *
 * Both cloud APIs page their collection listings (Hetzner defaults to 25
 * rows and hides the rest behind `meta.pagination.next_page`; DigitalOcean
 * behind `links.pages.next`). Every consumer in this repo filters
 * CLIENT-side, so an un-paginated collection GET does not merely return
 * fewer rows — it makes the missing rows unmatchable and the caller reports
 * "nothing found" with full confidence. That shape shipped twice in one day
 * (HetznerProvider.listVolumes/listNetworks/listLoadBalancers leaking six
 * orphaned CSI volumes past a GREEN e2e run, and the zero-orphan audit
 * sweep's own listings printing "recheck clean" over unread pages) and two
 * more latent instances were found writing this test (both providers'
 * fetchServerTypes, feeding every interactive type picker).
 *
 * The per-site behavior is covered elsewhere (hetzner-pagination.test.ts,
 * sweep-pagination.test.ts, fetch-server-types-pagination.test.ts). THIS
 * test is the class guard: it sweeps every provider-API call site in src/,
 * scripts/, and tests/e2e/ and fails on any NEW collection GET that neither
 * walks pagination, filters by exact `?name=`, addresses a single resource,
 * nor carries a documented exception below. Follow walg-dockerfile-arch's
 * inventory idiom: a new exception must be added HERE, with a reason, not
 * discovered in production.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SWEEP_ROOTS = ['src', 'scripts', join('tests', 'e2e')];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'results']);
const EXTENSIONS = ['.js', '.ts', '.mjs'];

/**
 * Sanctioned un-paginated collection GETs. Every row must carry a reason a
 * reviewer can re-check; the exact-match assertion below prunes stale rows
 * (a fixed site must leave this table).
 */
const EXCEPTIONS: Array<{ file: string; pathPrefix: string; reason: string }> = [
  {
    file: 'src/lib/hetzner-guided-setup.js',
    pathPrefix: '/locations?per_page=1',
    reason:
      'Credential probe: fetches exactly one row to validate the token; the rows are discarded, ' +
      'so truncation cannot mislead anything.',
  },
  {
    file: 'src/lib/digitalocean-guided-setup.js',
    pathPrefix: '/account',
    reason: 'Singleton resource (the account itself), not a collection — nothing to paginate.',
  },
  {
    file: 'src/lib/scaleway-guided-setup.js',
    pathPrefix: '/instance/v1/zones/fr-par-1/servers?per_page=1',
    reason:
      'Credential probe (same class as the Hetzner /locations?per_page=1 row): fetches exactly ' +
      'one row to validate the secret key; the rows are discarded, so truncation cannot mislead ' +
      'anything.',
  },
  {
    file: 'tests/e2e/utils/preflight.ts',
    pathPrefix: '/servers?per_page=1',
    reason:
      'Preflight health probe: proves the API answers; the single row is discarded, so ' +
      'truncation cannot mislead anything.',
  },
  {
    file: 'tests/e2e/utils/preflight.ts',
    pathPrefix: '/account',
    reason:
      'DO token-health probe against a singleton resource (the account itself) — nothing to ' +
      'paginate.',
  },
  {
    file: 'src/lib/providers/linode.js',
    pathPrefix: '/networking/firewalls/${firewallId}/rules',
    reason:
      "Singleton resource: one firewall's complete ruleset object " +
      '({inbound, outbound, *_policy}), returned whole — Linode does not paginate it, so ' +
      'truncation cannot occur (setFirewallRules reads it to preserve the outbound side).',
  },
  {
    file: 'src/lib/linode-guided-setup.js',
    pathPrefix: '/profile',
    reason:
      'Token-health probe against a singleton resource (the profile itself) — nothing to ' +
      'paginate. Same shape as the DO /account probe rows above.',
  },
  {
    file: 'src/lib/vultr-guided-setup.js',
    pathPrefix: '/account',
    reason:
      'Token-health probe against a singleton resource (the account itself) — nothing to ' +
      'paginate. Same shape as the DO /account and Linode /profile probe rows above.',
  },
];

interface Site {
  file: string;
  line: number;
  token: string;
}

function findSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        findSourceFiles(join(dir, entry.name), out);
      }
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return out;
}

// A provider-API URL path: either appended to an API_BASE-style template /
// literal host, or the path argument of the BaseProvider.apiRequest
// transport (which prefixes API_BASE itself).
const URL_SITE_RE =
  /(?:API_BASE\}|API_BASE_URL\}|api\.hetzner\.cloud\/v1|api\.digitalocean\.com\/v2)(\/[^\s`'"]+)/g;
const API_REQUEST_RE = /apiRequest\(\s*[`'"](\/[^`'"]+)/g;

/**
 * True when this call site cannot be a truncated listing:
 *  - id-addressed single resource (`/servers/${id}`) or action endpoint;
 *  - exact-name server-side filter (`?name=`);
 *  - explicit pagination (`page=` in the URL, a `&page=` continuation within
 *    the next few lines, or the shared listHetznerPages walker);
 *  - a mutation (POST/DELETE/PUT/PATCH), which returns no listing;
 *  - a URL constant whose every use appends a page param.
 */
function isSafe(token: string, window: string, line: string, source: string): boolean {
  const [path] = token.split('?');
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (last.includes('${')) return true;
  if (segments.includes('actions')) return true;
  if (/[?&]name=/.test(token)) return true;
  if (/[?&]page=/.test(token)) return true;
  if (/[?&]page=/.test(window)) return true;
  // Vultr's cursor idiom (2026-08-08): `meta.links.next` → `&cursor=`.
  // The first request legitimately carries no cursor param, so the
  // continuation evidence lives in the surrounding lines, same as the
  // `&page=` window clause above. VultrProvider funnels every listing
  // through _walkCursor, so its call sites also match the walker clause.
  if (/[?&]cursor=/.test(token)) return true;
  if (/[?&]cursor=/.test(window)) return true;
  if (/_walkCursor\s*\(/.test(window)) return true;
  // DO's page-link idiom: `links.pages.next` carries the absolute URL of the
  // next page, so the FIRST request legitimately has no `?page=` — the
  // continuation evidence is the follow-link in the surrounding lines, same
  // shape as the `&cursor=` clause above. This message already prescribes
  // this idiom as the remedy for a DO violation; without this clause the
  // sweep rejected the exact fix it recommends.
  if (/links\??\.?\s*(?:\?\.)?pages\??\.?\s*(?:\?\.)?next/.test(window)) return true;
  if (/listHetznerPages\s*\(/.test(window)) return true;
  if (/method:\s*['"](?:POST|DELETE|PUT|PATCH)/.test(window)) return true;
  // `const HETZNER_SERVERS_URL = '.../servers?per_page=50'` is fine when the
  // fetch site appends `&page=` to it.
  const decl = line.match(/^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_]+)\s*=/);
  if (decl && new RegExp(`\\$\\{${decl[1]}\\}[^\\n]*[?&]page=`).test(source)) return true;
  return false;
}

function collectSites(): { all: Site[]; unsafe: Site[] } {
  const all: Site[] = [];
  const unsafe: Site[] = [];
  for (const root of SWEEP_ROOTS) {
    for (const file of findSourceFiles(join(ROOT, root))) {
      const source = readFileSync(join(ROOT, file), 'utf-8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        const window = lines.slice(i, i + 10).join('\n');
        for (const re of [URL_SITE_RE, API_REQUEST_RE]) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) {
            const token = m[1];
            all.push({ file, line: i + 1, token });
            if (!isSafe(token, window, line, source)) {
              unsafe.push({ file, line: i + 1, token });
            }
          }
        }
      }
    }
  }
  return { all, unsafe };
}

const { all, unsafe } = collectSites();

describe('provider list-endpoint pagination sweep', () => {
  it('the scanner still sees the call-site population (not vacuously green)', () => {
    // If a refactor renames API_BASE / apiRequest and this collapses toward
    // zero, the sweep has gone blind — update the patterns, don't delete the
    // floor. ~60 sites existed when this was written.
    expect(all.length).toBeGreaterThanOrEqual(40);
  });

  it('every un-paginated collection GET is a documented exception', () => {
    const violations = unsafe.filter(
      (s) => !EXCEPTIONS.some((e) => s.file === e.file && s.token.startsWith(e.pathPrefix)),
    );
    const detail = violations.map((v) => `  ${v.file}:${v.line}  ${v.token}`).join('\n');
    expect(
      violations,
      `Un-paginated provider collection GET(s):\n${detail}\n\n` +
        'The API pages this listing (Hetzner: 25/page default behind meta.pagination.next_page; ' +
        'DO: links.pages.next) and every consumer filters client-side, so truncation reads as ' +
        '"nothing found". Walk the pages (listHetznerPages for Hetzner, the links.pages.next ' +
        'idiom for DO), filter server-side with ?name=, or — only if truncation genuinely cannot ' +
        'mislead — add a documented EXCEPTIONS row in this test.',
    ).toEqual([]);
  });

  it('the EXCEPTIONS table carries no stale rows', () => {
    const stale = EXCEPTIONS.filter(
      (e) => !unsafe.some((s) => s.file === e.file && s.token.startsWith(e.pathPrefix)),
    );
    expect(
      stale.map((e) => `${e.file} ${e.pathPrefix}`),
      'These exceptions no longer match any un-paginated call site — the site was fixed or moved. ' +
        'Remove the row so the table stays an honest inventory.',
    ).toEqual([]);
  });
});

describe('classifier sanity (not vacuously permissive)', () => {
  const src = 'nothing relevant';
  it('flags a bare collection GET', () => {
    expect(isSafe('/volumes', 'await fetchWithRetry(url, { headers });', '', src)).toBe(false);
    expect(isSafe('/volumes?per_page=50', 'await fetch(url);', '', src)).toBe(false);
  });

  it('accepts id-addressed, name-filtered, paginated, action, and mutation sites', () => {
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: asserting literal source-text shapes, not JS templates
    expect(isSafe('/volumes/${id}', '', '', src)).toBe(true);
    expect(isSafe('/servers?name=${name}', '', '', src)).toBe(true);
    expect(isSafe('/volumes?per_page=50&page=${page}', '', '', src)).toBe(true);
    expect(isSafe('/firewalls/${id}/actions/set_rules', '', '', src)).toBe(true);
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end
    expect(isSafe('/ssh_keys', "method: 'POST',", '', src)).toBe(true);
  });

  it('does NOT accept per_page alone as pagination (the [?&]page= anchor is load-bearing)', () => {
    // "per_page" contains the substring "page=" — a sloppy regex here would
    // wave through the exact single-page GETs this sweep exists to catch.
    expect(isSafe('/sizes?per_page=200', 'await fetch(url);', '', src)).toBe(false);
  });
});
