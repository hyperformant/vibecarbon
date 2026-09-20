/**
 * Docs census for the operator/project env example files.
 *
 * Forward direction: every `CONFIG_KEYS` registry entry must be documented in
 * the example file its `where` names — `.env.local` / `operator shell` ->
 * `carbon/.env.local.example`, `.env` -> `carbon/.env.example`,
 * `tests/.env.e2e` -> `tests/.env.e2e.example` — as a live `KEY=` line
 * preceded (within 3 lines) by a `# format: <describe>` comment. `<describe>`
 * is `entry.shape?.describe ?? KIND_PROSE[entry.kind]`: this census IS the
 * single arbiter of that text, so an entry's format line either matches its
 * shape's own `describe` (Task 1's registry, unaffected by this file) or the
 * kind-prose fallback below — for kinds `operator-env.js`'s KIND_FALLBACKS
 * already covers (port/email/hostname/url/cidr-list/pem) the prose here is
 * copied verbatim from there so a doc line and a live validation error never
 * disagree; for kinds with no such fallback (token/secret/id/slug/flag/enum)
 * this census defines the prose because nothing else does.
 *
 * Reverse direction: every live `KEY=` line in those three example files is
 * either a registry entry, actually read somewhere under `carbon/src/**`
 * (process.env.KEY, import.meta.env.KEY, a `{{KEY}}` create-time template
 * placeholder, a zod schema key in carbon/src/server/lib/env.ts, or a bare
 * quoted 'KEY' literal used for a dynamic env lookup — see
 * carbon/src/client/lib/admin-services.ts's envFlag pattern), or explicitly
 * listed in TEMPLATE_APP_ONLY_KEYS with the compose file / script that reads
 * it. Nothing documented is allowed to be dead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, type ConfigKey, registryEntry } from '../../../src/lib/config-registry.js';
import { parseDotenv } from '../../../src/lib/project.js';

const ROOT = process.cwd();

// Kinds `operator-env.js`'s KIND_FALLBACKS already gives a describe for
// (consulted there only when a registry entry carries no `shape` of its
// own) — copied verbatim so a doc line and a live validation error can never
// disagree. Kinds with neither a registry shape nor an operator-env fallback
// (token/secret/id/slug/flag) get their prose defined here, because nothing
// else does; 'enum' is included defensively even though every current enum
// entry carries its own shape.
const KIND_PROSE: Record<ConfigKey['kind'], string> = {
  port: '1-65535',
  email: 'an email address',
  hostname: 'a hostname',
  url: 'a URL',
  'cidr-list': 'comma-separated IPv4 CIDRs',
  pem: 'a PEM block (or its base64 encoding)',
  token: 'an opaque token',
  secret: 'an opaque secret',
  id: 'an opaque identifier',
  slug: 'a short identifier',
  flag: 'true or false',
  enum: 'one of a fixed set of values',
};

/** The '# format: …' text this census requires for `entry`. */
function describeFor(entry: ConfigKey): string {
  const describe = entry.shape?.describe ?? KIND_PROSE[entry.kind];
  if (!describe)
    throw new Error(`${entry.key}: no shape.describe and no KIND_PROSE[${entry.kind}]`);
  return describe;
}

const EXAMPLE_FILE_FOR_WHERE: Record<ConfigKey['where'], string> = {
  '.env.local': 'carbon/.env.local.example',
  'operator shell': 'carbon/.env.local.example',
  '.env': 'carbon/.env.example',
  'tests/.env.e2e': 'tests/.env.e2e.example',
};

const EXAMPLE_FILES = [...new Set(Object.values(EXAMPLE_FILE_FOR_WHERE))];

function readExample(relPath: string): string[] {
  return readFileSync(join(ROOT, relPath), 'utf-8').split('\n');
}

describe('env docs census — forward: every registry entry is documented with its format', () => {
  const filesLines = Object.fromEntries(EXAMPLE_FILES.map((f) => [f, readExample(f)]));

  it('every CONFIG_KEYS entry has a live KEY= line, with "# format: <describe>" within 3 lines above it', () => {
    const problems: string[] = [];
    for (const entry of CONFIG_KEYS) {
      const file = EXAMPLE_FILE_FOR_WHERE[entry.where];
      const lines = filesLines[file];
      const idx = lines.findIndex((l) => l.startsWith(`${entry.key}=`));
      if (idx === -1) {
        problems.push(`${entry.key}: no "${entry.key}=" line in ${file} (where: ${entry.where})`);
        continue;
      }
      const want = `# format: ${describeFor(entry)}`;
      const above = lines.slice(Math.max(0, idx - 3), idx);
      if (!above.some((l) => l.trim() === want)) {
        problems.push(
          `${entry.key}: missing '${want}' within 3 lines above ${file}:${idx + 1}\n` +
            `    saw:\n${above.map((l) => `      ${l}`).join('\n')}`,
        );
      }
    }
    expect(
      problems,
      `${problems.length} registry entr${problems.length === 1 ? 'y' : 'ies'} undocumented or mismatched:\n${problems.join('\n')}`,
    ).toEqual([]);
  });
});

// Keys documented in one of the three example files that are NOT registry
// entries but genuinely are consumed — just not by carbon/src. Each reason
// names the file that reads it; verified by grepping
// carbon/docker-compose*.yml, carbon/scripts, and (for the one module that
// lives outside carbon/) services/observability before being listed here. A
// key that stops being read anywhere is caught by the "still holds" test
// below — it can't rot silently.
const TEMPLATE_APP_ONLY_KEYS: Record<string, string> = {
  VITE_PUBLIC_URL:
    'read by carbon/scripts/generate-sitemap.ts, generate-seo.ts, generate-rss.ts and dev-init.js ' +
    '(build-time SEO/dev scripts), not carbon/src.',
  ADMIN_PASSWORD:
    "read by carbon/docker-compose.metabase.yml (METABASE_ADMIN_PASSWORD's fallback) and " +
    'carbon/scripts/dev-init.js; not read by carbon/src.',
  GRAFANA_URL:
    'read by services/observability/compose/docker-compose.yml (GF_SERVER_ROOT_URL) — the ' +
    'observability module lives outside carbon/, copied in by `vibecarbon add observability`.',
  N8N_DB_PASSWORD: "read by carbon/docker-compose.n8n.yml only (n8n's own Postgres role).",
  N8N_ENCRYPTION_KEY: 'read by carbon/docker-compose.n8n.yml only.',
  N8N_HOST: 'read by carbon/docker-compose.n8n*.yml only.',
  N8N_PROTOCOL: 'read by carbon/docker-compose.n8n*.yml only.',
  N8N_WEBHOOK_URL: 'read by carbon/docker-compose.n8n.yml only.',
  N8N_EDITOR_BASE_URL: 'read by carbon/docker-compose.n8n*.yml only.',
  METABASE_SITE_URL: 'read by carbon/docker-compose.metabase.yml (MB_SITE_URL) only.',
  S3_ENDPOINT: 'read by carbon/docker-compose.yml (AWS_ENDPOINT for wal-g) only.',
  S3_BUCKET: 'read by carbon/docker-compose.yml (WALG_S3_PREFIX fallback) only.',
  S3_REGION: 'read by carbon/docker-compose.yml (AWS_REGION for wal-g) only.',
  S3_ACCESS_KEY: 'read by carbon/docker-compose.yml (AWS_ACCESS_KEY_ID for wal-g) only.',
  S3_SECRET_KEY: 'read by carbon/docker-compose.yml (AWS_SECRET_ACCESS_KEY for wal-g) only.',
};

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readCarbonSrcSources(): string[] {
  return walkTsFiles(join(ROOT, 'carbon', 'src')).map((f) => readFileSync(f, 'utf-8'));
}

/**
 * True when `key` is genuinely read somewhere under carbon/src: a
 * process.env/import.meta.env access (member or bracket form), a bare `env.`
 * property access (carbon/src/server/lib/env.ts's exported `env` object), a
 * `{{KEY}}` create-time template placeholder (src/create.js's `variables`
 * substitution — e.g. Logo.tsx's `'{{PROJECT_DISPLAY_NAME}}'` default), a
 * zod schema property in env.ts, or a bare quoted 'KEY' literal (the
 * envFlag-style indirection in carbon/src/client/lib/admin-services.ts,
 * where the literal names the key and a separate line does the dynamic
 * `import.meta.env[service.envFlag]` lookup).
 */
function readByCarbonSrc(key: string, sources: string[]): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(process\\.env\\.${escaped}\\b` +
      `|process\\.env\\[['"]${escaped}['"]\\]` +
      `|import\\.meta\\.env\\.${escaped}\\b` +
      `|import\\.meta\\.env\\[['"]${escaped}['"]\\]` +
      `|\\benv\\.${escaped}\\b` +
      `|\\{\\{${escaped}\\}\\}` +
      `|['"]${escaped}['"]` +
      `|^\\s*${escaped}\\s*:\\s*z\\.)`,
    'm',
  );
  return sources.some((src) => re.test(src));
}

describe('env docs census — reverse: every documented key is a registry entry or genuinely read', () => {
  const sources = readCarbonSrcSources();
  const allExampleKeys = new Map<string, string[]>(); // key -> files it appears in

  for (const file of EXAMPLE_FILES) {
    const parsed = parseDotenv(readFileSync(join(ROOT, file), 'utf-8'));
    for (const key of Object.keys(parsed)) {
      const files = allExampleKeys.get(key) ?? [];
      files.push(file);
      allExampleKeys.set(key, files);
    }
  }

  it('every KEY= in the example files is a registry entry, read by carbon/src, or a listed template-app-only key', () => {
    const problems: string[] = [];
    for (const [key, files] of allExampleKeys) {
      if (registryEntry(key)) continue;
      if (readByCarbonSrc(key, sources)) continue;
      if (key in TEMPLATE_APP_ONLY_KEYS) continue;
      problems.push(
        `${key} (in ${files.join(', ')}): not registered, not read by carbon/src, not in TEMPLATE_APP_ONLY_KEYS`,
      );
    }
    expect(problems, `dead documentation:\n${problems.join('\n')}`).toEqual([]);
  });

  it('TEMPLATE_APP_ONLY_KEYS cannot rot: every listed key still appears in an example file and is NOT registry-backed', () => {
    const stale = Object.keys(TEMPLATE_APP_ONLY_KEYS).filter((k) => !allExampleKeys.has(k));
    expect(stale, 'listed as template-app-only but no example file documents it any more').toEqual(
      [],
    );
    const nowRegistered = Object.keys(TEMPLATE_APP_ONLY_KEYS).filter((k) => registryEntry(k));
    expect(nowRegistered, 'now a registry entry — drop it from TEMPLATE_APP_ONLY_KEYS').toEqual([]);
  });

  it('TEMPLATE_APP_ONLY_KEYS cannot mask a real carbon/src read (a genuine gap should be closed, not hidden)', () => {
    const shouldveBeenFound = Object.keys(TEMPLATE_APP_ONLY_KEYS).filter((k) =>
      readByCarbonSrc(k, sources),
    );
    expect(
      shouldveBeenFound,
      'these are actually read by carbon/src — remove from TEMPLATE_APP_ONLY_KEYS',
    ).toEqual([]);
  });
});

describe('env docs census — supporting files exist where expected', () => {
  it('carbon/.env.local.example exists (the .env.local docs counterpart)', () => {
    expect(() => readFileSync(join(ROOT, 'carbon/.env.local.example'), 'utf-8')).not.toThrow();
  });

  it('carbon/_gitignore does not ignore .env.local.example', () => {
    const gitignore = readFileSync(join(ROOT, 'carbon/_gitignore'), 'utf-8');
    const lines = gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    // The only patterns that could plausibly catch it: an exact '.env.local'
    // match (gitignore exact names match the whole basename, not a prefix —
    // '.env.local' itself IS expected to be listed here, it just must not
    // equal '.env.local.example') and the '.env.*.local' glob (requires the
    // name to END in '.local' — '.env.local.example' ends in '.example', so
    // it can't match either).
    expect(lines).not.toContain('.env.local.example');
    for (const pattern of lines) {
      if (!pattern.includes('*')) continue;
      const re = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
      expect(
        re.test('.env.local.example'),
        `${pattern} unexpectedly matches .env.local.example`,
      ).toBe(false);
    }
  });

  it('src/create.js copies .env.local.example alongside .env.example', () => {
    const src = readFileSync(join(ROOT, 'src', 'create.js'), 'utf-8');
    expect(src).toMatch(/\.env\.local\.example/);
  });
});
