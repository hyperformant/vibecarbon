/**
 * Census: every code path that creates or replaces Secret/vibecarbon-tls goes
 * through buildRestoredTlsSecret (src/lib/deploy/tls-snapshot.js).
 *
 * Why. cert-manager v1.20.2 keeps Secrets labelled
 * `controller.cert-manager.io/fao: "true"` in a typed informer cache and every
 * other Secret in a metadata-only cache (internal/informers/
 * core_filteredsecrets.go). A Secret that gains or loses the label moves from
 * one cache to the other, and in that moment the lister's Get answers
 * NotFound. On a real DO cluster a restored Secret written without the label
 * was labelled by cert-manager's SecretsManager right after the Certificate
 * was applied, and 0.6 s later the trigger controller logged "Certificate must
 * be re-issued ... reason=DoesNotExist" and issued a new certificate.
 * buildRestoredTlsSecret writes the label and every annotation cert-manager
 * would add, so a writer that builds the Secret any other way brings the
 * re-issue back.
 *
 * Rules, over every text file under src/, carbon/, scripts/ and services/:
 *   1. A Secret manifest (`kind: Secret` in YAML or a JS object) named
 *      vibecarbon-tls, literally or through a constant holding that name,
 *      appears only in tls-snapshot.js.
 *   2. No imperative kubectl write names a vibecarbon-tls Secret
 *      (`create secret tls`, `create secret generic vibecarbon-tls`,
 *      `patch|label|annotate|replace|edit|apply ... secret ... vibecarbon-tls`):
 *      each of those would write or rewrite its labels around the builder.
 *   3. buildRestoredTlsSecret is called only by restoreK8sTlsSecret
 *      (tls-restore.js), whose create/replace sends that manifest; and
 *      restoreK8sTlsSecret is called only by the deploy (k3s.js) and the
 *      failover promotion (failover.js).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const ROOTS = ['src', 'carbon', 'scripts', 'services'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|sh|ya?ml|json|tpl)$/;
const BUILDER_FILE = 'src/lib/deploy/tls-snapshot.js';
const SECRET = 'vibecarbon-tls';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(name)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(join(REPO, r))).map((full) => ({
  path: relative(REPO, full),
  text: readFileSync(full, 'utf8'),
}));

/** Identifiers a file binds to the literal 'vibecarbon-tls'. */
function secretNameConstants(text: string): string[] {
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]vibecarbon-tls['"`]/g;
  return [...text.matchAll(re)].map((m) => m[1]);
}

const KIND_SECRET = /\bkind:\s*['"]?Secret['"]?\s*[,'"]?\s*$/;

/** `file:line` of every Secret manifest whose name is vibecarbon-tls. */
function tlsSecretManifests(path: string, text: string): string[] {
  const lines = text.split('\n');
  const consts = secretNameConstants(text);
  const names = [SECRET, ...consts];
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (!KIND_SECRET.test(line)) return;
    // The name sits in the next few lines of the manifest (metadata.name).
    const window = lines.slice(i + 1, i + 9).join('\n');
    const m = window.match(/\bname['"]?\s*:\s*(.+)/);
    if (!m) return;
    const value = m[1];
    if (
      names.some((n) =>
        new RegExp(`(^|[^\\w$-])${n.replace(/[$]/g, '\\$')}([^\\w$-]|$)`).test(value),
      )
    ) {
      hits.push(`${path}:${i + 1}`);
    }
  });
  return hits;
}

const IMPERATIVE_WRITES = [
  /create\s+secret\s+tls\b/,
  /create\s+secret\s+generic\s+['"]?vibecarbon-tls\b/,
  /\b(patch|label|annotate|replace|edit|apply)\b[^\n]{0,80}\bsecrets?\b[^\n]{0,40}vibecarbon-tls\b/,
  /\b(patch|label|annotate|replace|edit)\b[^\n]{0,40}secret\/vibecarbon-tls\b/,
];

function imperativeWrite(line: string): boolean {
  return IMPERATIVE_WRITES.some((re) => re.test(line));
}

describe('the census matchers', () => {
  it('see a YAML or JS Secret manifest named vibecarbon-tls, directly or by constant', () => {
    const yaml = ['apiVersion: v1', 'kind: Secret', 'metadata:', '  name: vibecarbon-tls'].join(
      '\n',
    );
    expect(tlsSecretManifests('a.yaml', yaml)).toEqual(['a.yaml:2']);
    const js = [
      "const TLS = 'vibecarbon-tls';",
      'const m = [',
      "  'kind: Secret',",
      "  'metadata:',",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of a template literal.
      '  `  name: ${TLS}`,',
      '];',
    ].join('\n');
    expect(tlsSecretManifests('b.js', js)).toEqual(['b.js:3']);
    const other = ['kind: Secret', 'metadata:', '  name: vibecarbon-app-secrets'].join('\n');
    expect(tlsSecretManifests('c.yaml', other)).toEqual([]);
  });
  it('see imperative kubectl writes of the Secret', () => {
    expect(imperativeWrite('kubectl create secret tls vibecarbon-tls --cert=a --key=b')).toBe(true);
    expect(imperativeWrite('kubectl -n vibecarbon label secret vibecarbon-tls a=b')).toBe(true);
    expect(imperativeWrite("['patch', 'secret', 'vibecarbon-tls', '-n', 'vibecarbon']")).toBe(true);
    expect(imperativeWrite('kubectl get secret vibecarbon-tls -n vibecarbon -o json')).toBe(false);
  });
});

describe('Secret/vibecarbon-tls writer census', () => {
  it('finds the files it walks', () => {
    expect(FILES.some((f) => f.path === BUILDER_FILE)).toBe(true);
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('the census sees the builder itself (rule 1 is live)', () => {
    const builder = FILES.find((f) => f.path === BUILDER_FILE);
    expect(builder && tlsSecretManifests(builder.path, builder.text)).toHaveLength(1);
  });

  it('builds a vibecarbon-tls Secret manifest only in buildRestoredTlsSecret', () => {
    const outside = FILES.filter((f) => f.path !== BUILDER_FILE).flatMap((f) =>
      tlsSecretManifests(f.path, f.text),
    );
    expect(outside).toEqual([]);
  });

  it('never writes the vibecarbon-tls Secret with an imperative kubectl command', () => {
    const hits = FILES.flatMap((f) =>
      f.text
        .split('\n')
        .map((line, i) => ({ line, at: `${f.path}:${i + 1}` }))
        .filter(({ line }) => imperativeWrite(line))
        .map(({ at }) => at),
    );
    expect(hits).toEqual([]);
  });

  it('calls buildRestoredTlsSecret only from restoreK8sTlsSecret, which sends its manifest', () => {
    const callers = FILES.filter(
      (f) => f.path !== BUILDER_FILE && /\bbuildRestoredTlsSecret\s*\(/.test(f.text),
    ).map((f) => f.path);
    expect(callers).toEqual(['src/lib/deploy/k8s/tls-restore.js']);

    const restore = FILES.find((f) => f.path === 'src/lib/deploy/k8s/tls-restore.js')?.text ?? '';
    expect(restore).toMatch(/const manifest = buildRestoredTlsSecret\(/);
    // The one create/replace of the Secret sends that manifest, and nothing
    // else is ever sent on stdin from this file.
    const inputs = [...restore.matchAll(/\binput:\s*([^\n,]+)/g)].map((m) => m[1].trim());
    expect(inputs).toEqual(['JSON.stringify(manifest)']);
  });

  it('calls restoreK8sTlsSecret only from the deploy and the failover promotion', () => {
    const callers = FILES.filter((f) =>
      f.text
        .split('\n')
        .some(
          (line) =>
            /\brestoreK8sTlsSecret\s*\(/.test(line) && !/function\s+restoreK8sTlsSecret/.test(line),
        ),
    )
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual(['src/failover.js', 'src/lib/deploy/k8s/k3s.js']);
  });
});
