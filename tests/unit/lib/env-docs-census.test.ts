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
 *
 * TEMPLATE_APP_ONLY_KEYS is not just a free-text exemption list: every entry
 * is mechanically checked (below) against real compose/script sources. The
 * check specifically distinguishes a compose line that INTERPOLATES `${KEY}`
 * (a genuine read of the operator's value) from a line that merely ASSIGNS a
 * container variable of the same name from a different source, e.g.
 * `N8N_DB_PASSWORD=${POSTGRES_PASSWORD}` — the container var happens to be
 * named N8N_DB_PASSWORD, but the value comes from POSTGRES_PASSWORD, so the
 * operator's N8N_DB_PASSWORD is never read at all. That exact shape shipped
 * as a mislabeled TEMPLATE_APP_ONLY_KEYS entry once (code review caught it,
 * 2026-09-19) — this mechanical check exists so the census catches it next
 * time instead of relying on the researcher noticing the assignment runs the
 * other direction.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, type ConfigKey, registryEntry } from '../../../src/lib/config-registry.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';

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
  'cidr-list': 'comma-separated IPv4/IPv6 addresses or CIDRs like 203.0.113.0/24',
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
// cites the exact file:line that INTERPOLATES ${KEY} (compose) or reads
// process.env.KEY (a script) — never a same-named assignment from a
// different source (see the file header). Verified by grep against
// carbon/docker-compose*.yml, carbon/scripts, and (for the one module that
// lives outside carbon/) services/observability before being listed here,
// and re-verified mechanically below (composeReadsKey/scriptReadsKey). A key
// that stops being read anywhere is caught by the "still holds" test below —
// it can't rot silently. dev-init.js is deliberately never cited: it writes
// a fully hardcoded DEV object into a generated dev .env (never reads
// process.env), so it is not a read of anything.
const TEMPLATE_APP_ONLY_KEYS: Record<string, string> = {
  VITE_PUBLIC_URL:
    'carbon/scripts/generate-sitemap.ts:39, generate-rss.ts:32, generate-seo.ts:94 ' +
    "(getEnvValue('VITE_PUBLIC_URL'), which reads process.env then the layered .env files) " +
    '— build-time SEO scripts, not carbon/src.',
  ADMIN_PASSWORD:
    'carbon/docker-compose.metabase.yml:73 — METABASE_ADMIN_PASSWORD falls back to the ' +
    'operator ADMIN_PASSWORD when METABASE_ADMIN_PASSWORD itself is unset.',
  GRAFANA_URL:
    'services/observability/compose/docker-compose.yml:49 — GF_SERVER_ROOT_URL falls back ' +
    'to the operator GRAFANA_URL. The observability module lives outside carbon/, copied in ' +
    'by `vibecarbon add observability`.',
  N8N_ENCRYPTION_KEY:
    'carbon/docker-compose.n8n.yml:38 — N8N_ENCRYPTION_KEY defaults from the operator ' +
    'N8N_ENCRYPTION_KEY of the same name (a genuine self-referencing read, not just a same name).',
  N8N_HOST: 'carbon/docker-compose.n8n.yml:31 — N8N_HOST defaults from the operator N8N_HOST.',
  N8N_PROTOCOL:
    'carbon/docker-compose.n8n.yml:33 — N8N_PROTOCOL defaults from the operator N8N_PROTOCOL.',
  N8N_WEBHOOK_URL:
    'carbon/docker-compose.n8n.yml:34 — the container WEBHOOK_URL defaults from the operator ' +
    'N8N_WEBHOOK_URL.',
  N8N_EDITOR_BASE_URL:
    'carbon/docker-compose.n8n.yml:35 — N8N_EDITOR_BASE_URL defaults from the operator ' +
    'N8N_EDITOR_BASE_URL of the same name.',
  METABASE_SITE_URL:
    'carbon/docker-compose.metabase.yml:29 — the container MB_SITE_URL defaults from the ' +
    'operator METABASE_SITE_URL.',
  S3_ENDPOINT: 'carbon/docker-compose.yml:228 — the wal-g AWS_ENDPOINT defaults from S3_ENDPOINT.',
  S3_BUCKET:
    'carbon/docker-compose.yml:224 — the WALG_S3_PREFIX bucket segment falls back to S3_BUCKET.',
  S3_REGION: 'carbon/docker-compose.yml:229 — the wal-g AWS_REGION defaults from S3_REGION.',
  S3_ACCESS_KEY:
    'carbon/docker-compose.yml:226,479 — the wal-g/storage AWS_ACCESS_KEY_ID defaults from ' +
    'S3_ACCESS_KEY.',
  S3_SECRET_KEY:
    'carbon/docker-compose.yml:227,480 — the wal-g/storage AWS_SECRET_ACCESS_KEY defaults ' +
    'from S3_SECRET_KEY.',
  // N8N_DB_PASSWORD was REMOVED (2026-09-19 code review): carbon/docker-compose.n8n.yml:87 sets
  // the container's N8N_DB_PASSWORD FROM POSTGRES_PASSWORD — it assigns a container var NAMED
  // N8N_DB_PASSWORD from a DIFFERENT source and never reads the operator's N8N_DB_PASSWORD at
  // all. The n8n role password really is POSTGRES_PASSWORD (carbon/volumes/db/n8n-init.sh), same
  // as METABASE_DB_PASSWORD before it. The .env.example line was dropped, not exempted — see the
  // mechanical check below.
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
 * zod schema property in env.ts, or an `envFlag: 'KEY'` property (the ONE
 * indirection in carbon/src/client/lib/admin-services.ts, where the literal
 * names the key and a separate line does the dynamic
 * `import.meta.env[service.envFlag]` lookup).
 *
 * Deliberately NOT a read (M15, review 2026-09-19): a bare quoted `'KEY'`
 * string literal anywhere. That earlier alternative made any key that
 * happened to appear in a string — an error message, a docs page, a test
 * fixture — count as consumed, which is exactly the false "still read"
 * signal this reverse check exists to reject. Only the env object's own
 * access forms, the zod key list and the one named indirection count.
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
      `|\\benvFlag\\s*:\\s*['"]${escaped}['"]` +
      `|^\\s*${escaped}\\s*:\\s*z\\.)`,
    'm',
  );
  return sources.some((src) => re.test(src));
}

describe('readByCarbonSrc — a bare quoted key in a string is not a read (M15)', () => {
  it('counts only env-object access forms, the zod key list and the envFlag indirection', () => {
    expect(readByCarbonSrc('FOO_KEY', ['const x = process.env.FOO_KEY;'])).toBe(true);
    expect(readByCarbonSrc('FOO_KEY', ["const x = process.env['FOO_KEY'];"])).toBe(true);
    expect(readByCarbonSrc('FOO_KEY', ['const x = import.meta.env.FOO_KEY;'])).toBe(true);
    expect(readByCarbonSrc('FOO_KEY', ['if (env.FOO_KEY) {}'])).toBe(true);
    expect(readByCarbonSrc('FOO_KEY', ["  envFlag: 'FOO_KEY',"])).toBe(true);
    expect(readByCarbonSrc('FOO_KEY', ['  FOO_KEY: z.string().optional(),'])).toBe(true);
    expect(readByCarbonSrc('FOO_KEY', ["title: '{{FOO_KEY}}'"])).toBe(true);

    // The false positives the narrowing removes.
    expect(readByCarbonSrc('FOO_KEY', ["throw new Error('FOO_KEY is required');"])).toBe(false);
    expect(readByCarbonSrc('FOO_KEY', ["const doc = 'set FOO_KEY in .env';"])).toBe(false);
    expect(readByCarbonSrc('FOO_KEY', ["const k = 'FOO_KEY';"])).toBe(false);
    expect(readByCarbonSrc('FOO_KEY', ['const x = env.FOO_KEY_SUFFIX;'])).toBe(false);
  });
});

/** All `carbon/docker-compose*.yml` files, plus the one module compose file that lives outside carbon/ (observability). */
function composeSources(): string[] {
  const carbonDir = join(ROOT, 'carbon');
  const carbonComposeFiles = readdirSync(carbonDir)
    .filter((f) => /^docker-compose.*\.yml$/.test(f))
    .map((f) => join(carbonDir, f));
  const outOfTree = [
    join(ROOT, 'services', 'observability', 'compose', 'docker-compose.yml'),
  ].filter(existsSync);
  return [...carbonComposeFiles, ...outOfTree].map((f) => readFileSync(f, 'utf-8'));
}

/** Every `.ts`/`.js` file directly under carbon/scripts (build-time Node scripts, not carbon/src). */
function scriptSources(): string[] {
  const dir = join(ROOT, 'carbon', 'scripts');
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|js)$/.test(e.name))
    .map((e) => join(dir, e.name));
  return files.map((f) => readFileSync(f, 'utf-8'));
}

/**
 * True when a compose source genuinely READS the operator's `key` — i.e.
 * contains a `${key}` (or `${key:-...}` / `${key:?...}` / `${key:=...}`)
 * interpolation ANYWHERE, on either side of an assignment. Deliberately does
 * NOT match on the assignment's left-hand side: `key=${OTHER}` sets a
 * container variable NAMED `key` from a DIFFERENT source and must NOT count
 * as a read of `key` — that is exactly the N8N_DB_PASSWORD shape this
 * function exists to reject (see the file header).
 */
function composeReadsKey(key: string, sources: string[]): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\$\\{${escaped}(:[-?=][^}]*)?\\}`);
  return sources.some((src) => re.test(src));
}

/**
 * True when a script source reads `process.env.key` (member or bracket
 * form), or calls the scripts' shared `getEnvValue('key')` helper — the
 * layered `process.env[key] ?? fileEnv[key]` read every carbon/scripts/*
 * env consumer now goes through (see carbon/scripts/lib/dotenv.js).
 */
function scriptReadsKey(key: string, sources: string[]): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `process\\.env\\.${escaped}\\b` +
      `|process\\.env\\[['"]${escaped}['"]\\]` +
      `|getEnvValue\\(['"]${escaped}['"]\\)`,
  );
  return sources.some((src) => re.test(src));
}

describe('composeReadsKey — a same-named assignment is not a read (the N8N_DB_PASSWORD shape)', () => {
  it('assigning KEY from a different variable does not count as reading KEY, but reading that other variable, or KEY appearing on a different line, does', () => {
    // These fixture lines are deliberately shaped like real compose YAML
    // interpolation syntax (${VAR}), not forgotten template literals.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${VAR} fixture
    const assignsFromDifferentSource = '      - N8N_DB_PASSWORD=${POSTGRES_PASSWORD}';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${VAR} fixture
    const selfReferencingDefault = '      - N8N_HOST=${N8N_HOST:-n8n.localhost}';
    const fixture = [assignsFromDifferentSource, selfReferencingDefault].join('\n');

    expect(composeReadsKey('N8N_DB_PASSWORD', [fixture]), 'assignment target is not a read').toBe(
      false,
    );
    expect(composeReadsKey('POSTGRES_PASSWORD', [fixture]), 'the RHS interpolation IS a read').toBe(
      true,
    );
    expect(composeReadsKey('N8N_HOST', [fixture]), 'self-referencing default IS a read').toBe(true);
  });

  it('recognizes the :-, :?, and := interpolation forms, not just a bare interpolation', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${VAR} fixture
    const bare = 'a: ${FOO}';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${VAR} fixture
    const withDefault = 'a: ${FOO:-default}';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${VAR} fixture
    const required = 'a: ${FOO:?required}';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${VAR} fixture
    const assignDefault = 'a: ${FOO:=default}';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal ${VAR} fixture, a different key
    const differentKey = 'a: ${FOOBAR}';

    expect(composeReadsKey('FOO', [bare])).toBe(true);
    expect(composeReadsKey('FOO', [withDefault])).toBe(true);
    expect(composeReadsKey('FOO', [required])).toBe(true);
    expect(composeReadsKey('FOO', [assignDefault])).toBe(true);
    expect(composeReadsKey('FOO', [differentKey])).toBe(false);
  });
});

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

  it('every TEMPLATE_APP_ONLY_KEYS entry is backed by a real compose interpolation or a process.env.KEY script read', () => {
    // Mechanical re-verification of the whole list, not just its prose: a
    // reason string can claim a file reads a key when the file actually just
    // assigns a same-named container var from something else entirely (the
    // N8N_DB_PASSWORD bug this test exists to catch). composeReadsKey/
    // scriptReadsKey are the same functions the fixture tests above pin.
    const compose = composeSources();
    const scripts = scriptSources();
    const problems = Object.keys(TEMPLATE_APP_ONLY_KEYS)
      .filter((key) => !composeReadsKey(key, compose) && !scriptReadsKey(key, scripts))
      .map(
        (key) =>
          `${key}: no \${${key}} interpolation in any compose file and no process.env.${key} ` +
          `in carbon/scripts — TEMPLATE_APP_ONLY_KEYS[${key}] is not backed by a real read`,
      );
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('env docs census — supporting files exist where expected', () => {
  it('carbon/.env.local.example exists (the .env.local docs counterpart)', () => {
    expect(() => readFileSync(join(ROOT, 'carbon/.env.local.example'), 'utf-8')).not.toThrow();
  });

  it('carbon/.env.local.example opens with the do-not-copy warning (A9: create writes real secrets into .env.local)', () => {
    // `vibecarbon create` writes the generated infra secrets (JWT_SECRET,
    // POSTGRES_PASSWORD, ...) into .env.local; a `cp .env.local.example
    // .env.local` — the reflex every other .example file invites — would
    // wipe them, and nothing can regenerate them for a running database.
    // The warning must be the FIRST thing under the banner, before any
    // sentence that describes the file as ".example counterpart".
    const lines = readFileSync(join(ROOT, 'carbon/.env.local.example'), 'utf-8').split('\n');
    const firstProse = lines.findIndex((l, i) => i >= 3 && l.startsWith('# ') && !/^# =+$/.test(l));
    expect(firstProse).toBeGreaterThan(0);
    expect(lines[firstProse]).toMatch(/^# DO NOT copy this file over \.env\.local/);
    const header = lines.slice(0, 40).join('\n');
    // (Wrapped at 80 columns, hence the tolerant join.)
    expect(header).toMatch(/Append the keys you need, or run\s+(# )?`vibecarbon configure`\./);
    // The header may no longer claim every documented key stays off the
    // server unqualified — ACME_CA_SERVER moved to .env.example (A1) and the
    // sentence has to scope itself to THESE keys.
    expect(header).not.toMatch(/none of them are ever written to a deployed server/);
    expect(header).toMatch(/VIBECARBON_SKIP_CONFIG_SHAPES=1/);
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
      // Escape every regex metacharacter first (CodeQL js/incomplete-sanitization:
      // a gitignore line may legally contain `+`, `?`, `(`, `\\` …), then turn the
      // gitignore `*` (escaped to `\\*` by the previous step) into a path-segment glob.
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${escaped.replace(/\\\*/g, '[^/]*')}$`);
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
