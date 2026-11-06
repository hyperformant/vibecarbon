/**
 * Census: every code path that creates or replaces Secret/vibecarbon-tls goes
 * through buildRestoredTlsSecret (src/lib/deploy/tls-snapshot.js).
 *
 * Why. cert-manager v1.21.3 keeps Secrets labelled
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
 *   1. A Secret manifest (`kind: Secret` in YAML, `"kind": "Secret"` in JSON,
 *      a JS object literal on one line or many) named vibecarbon-tls,
 *      literally or through a constant of the same file holding that name,
 *      appears only in tls-snapshot.js.
 *   2. No imperative kubectl write names the Secret: `create secret tls`, or
 *      `create|patch|label|annotate|replace|edit|apply` then `secret` then
 *      vibecarbon-tls (or such a constant, or `secret/<name>`), on one shell
 *      line or spread over a multi-line argv array. Each would write or
 *      rewrite its labels around the builder.
 *   3. buildRestoredTlsSecret is called only by restoreK8sTlsSecret
 *      (tls-restore.js), whose create/replace sends that manifest; and
 *      restoreK8sTlsSecret is called only by the deploy (k3s.js) and the
 *      failover promotion (failover.js).
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const ROOTS = ['src', 'carbon', 'scripts', 'services'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|sh|ya?ml|json|tpl)$/;
const BUILDER_FILE = 'src/lib/deploy/tls-snapshot.js';
const SECRET = 'vibecarbon-tls';

type SourceFile = { path: string; text: string };

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(name)) out.push(full);
  }
  return out;
}

function readTree(root: string): SourceFile[] {
  return ROOTS.flatMap((r) => walk(join(root, r))).map((full) => ({
    path: relative(root, full),
    text: readFileSync(full, 'utf8'),
  }));
}

/** Identifiers a file binds to the literal 'vibecarbon-tls'. */
function secretNameConstants(text: string): string[] {
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]vibecarbon-tls['"`]/g;
  return [...text.matchAll(re)].map((m) => m[1]);
}

/** True when `value` names the Secret: the literal, or one of `consts` as a whole token. */
function namesSecret(value: string, consts: string[]): boolean {
  return [SECRET, ...consts].some((n) =>
    new RegExp(`(^|[^\\w$-])${n.replace(/[\\$]/g, '\\$&')}([^\\w$-]|$)`).test(value),
  );
}

/** `kind: Secret`, `"kind": "Secret"`, `kind: 'Secret'`, never `kind: SecretStore`. */
const KIND_SECRET = /["']?\bkind["']?\s*:\s*["'`]?Secret(?![\w-])/g;

/** `file:line` of every Secret manifest whose name is vibecarbon-tls. */
function tlsSecretManifests(path: string, text: string): string[] {
  const consts = secretNameConstants(text);
  const hits: string[] = [];
  for (const m of text.matchAll(KIND_SECRET)) {
    const at = m.index ?? 0;
    // The manifest around the marker: the rest of its line before it (a
    // one-line object literal may name it first), and what follows, up to
    // the next manifest.
    const lineStart = text.lastIndexOf('\n', at) + 1;
    let after = text.slice(at + m[0].length, at + m[0].length + 400);
    const next = after.search(/\bkind["']?\s*:|\n---/);
    if (next >= 0) after = after.slice(0, next);
    const around = `${text.slice(lineStart, at)}\n${after}`;
    const name = around.match(/["']?\bname["']?\s*:\s*([^\n,}]+)/);
    if (name && namesSecret(name[1], consts)) {
      hits.push(`${path}:${text.slice(0, at).split('\n').length}`);
    }
  }
  return hits;
}

const WRITE_VERB = /(?<![\w$-])(create|patch|label|annotate|replace|edit|apply)(?![\w$-])/g;

/**
 * `file:line` of every kubectl write of the Secret: a write verb, then a
 * `secret` resource, then the name (the literal, a constant holding it, or
 * `secret/<name>`), within one command. A command ends at `]`, `;`, `&&`,
 * `||`, `|` or a newline that is not a shell continuation or inside an argv
 * array, so a multi-line argv counts as one command.
 */
function imperativeWrites(path: string, text: string): string[] {
  const consts = secretNameConstants(text);
  const names = new Set([SECRET, ...consts]);
  const hits: string[] = [];
  for (const m of text.matchAll(WRITE_VERB)) {
    const at = m.index ?? 0;
    let cmd = text.slice(at, at + 240);
    const end = cmd.search(/\]|;|&&|\|\||\||[^\\,[\s]\s*\n(?!\s*['"`\]])/);
    if (end >= 0) cmd = cmd.slice(0, end + 1);
    const tokens = cmd.split(/[^\w$./-]+/).filter(Boolean);
    const secretAt = tokens.findIndex((t) => t === 'secret' || t === 'secrets');
    const slashName = tokens.some(
      (t) => /^secrets?\//.test(t) && names.has(t.replace(/^secrets?\//, '')),
    );
    const createTls = m[1] === 'create' && secretAt >= 0 && tokens[secretAt + 1] === 'tls';
    const named = secretAt >= 0 && tokens.slice(secretAt + 1).some((t) => names.has(t));
    if (slashName || createTls || named) {
      hits.push(`${path}:${text.slice(0, at).split('\n').length}`);
    }
  }
  return hits;
}

/** Every violation of rules 1 and 2 in the tree at `root`. */
function censusViolations(root: string): string[] {
  return readTree(root).flatMap((f) => [
    ...(f.path === BUILDER_FILE ? [] : tlsSecretManifests(f.path, f.text)),
    ...imperativeWrites(f.path, f.text),
  ]);
}

const FILES = readTree(REPO);

describe('the census matchers', () => {
  it('see a YAML, JSON or JS Secret manifest named vibecarbon-tls, directly or by constant', () => {
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
    const json =
      '{\n  "apiVersion": "v1",\n  "kind": "Secret",\n  "metadata": { "name": "vibecarbon-tls" }\n}';
    expect(tlsSecretManifests('c.json', json)).toEqual(['c.json:3']);
    const oneLine = [
      "const N = 'vibecarbon-tls';",
      "const s = { metadata: { name: N }, kind: 'Secret', data: {} };",
      "const t = { kind: 'Secret', metadata: { name: N } };",
    ].join('\n');
    expect(tlsSecretManifests('d.js', oneLine)).toEqual(['d.js:2', 'd.js:3']);
    const other = ['kind: Secret', 'metadata:', '  name: vibecarbon-app-secrets'].join('\n');
    expect(tlsSecretManifests('e.yaml', other)).toEqual([]);
    expect(
      tlsSecretManifests('f.yaml', 'kind: SecretStore\nmetadata:\n  name: vibecarbon-tls'),
    ).toEqual([]);
  });

  it('see imperative kubectl writes of the Secret, on one line or across an argv array', () => {
    const w = (t: string) => imperativeWrites('x', t).length > 0;
    expect(w('kubectl create secret tls vibecarbon-tls --cert=a --key=b')).toBe(true);
    expect(w('kubectl create secret tls other --cert=a --key=b')).toBe(true);
    expect(w('kubectl -n vibecarbon label secret vibecarbon-tls a=b')).toBe(true);
    expect(w('kubectl annotate secret/vibecarbon-tls a=b')).toBe(true);
    expect(w("['patch', 'secret', 'vibecarbon-tls', '-n', 'vibecarbon']")).toBe(true);
    expect(w("const NAME = 'vibecarbon-tls';\nrun(['label', 'secret', NAME, 'a=b']);")).toBe(true);
    expect(
      w(
        "const NAME = 'vibecarbon-tls';\nawait runKubectl([\n  'patch',\n  'secret',\n  NAME,\n  '-n',\n  'vibecarbon',\n]);",
      ),
    ).toBe(true);
    expect(w('kubectl create secret generic vibecarbon-tls \\\n  --from-file=tls.crt=a')).toBe(
      true,
    );
    expect(w('kubectl get secret vibecarbon-tls -n vibecarbon -o json')).toBe(false);
    expect(w('kubectl create secret generic vibecarbon-app-secrets --from-literal=a=b')).toBe(
      false,
    );
    expect(
      w("const NAME = 'vibecarbon-tls';\nrun(['apply', '-f', '-']);\nget(['secret', NAME]);"),
    ).toBe(false);
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

  it('finds no writer of the Secret outside buildRestoredTlsSecret (rules 1 and 2)', () => {
    expect(censusViolations(REPO)).toEqual([]);
  });

  it('bites: a planted writer in a scanned tree fails the census', () => {
    const root = mkdtempSync(join(tmpdir(), 'tls-writer-census-'));
    const plant = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    try {
      plant(
        BUILDER_FILE,
        "const K = 'vibecarbon-tls';\nexport const m = { kind: 'Secret', metadata: { name: K } };\n",
      );
      plant('src/clean.js', "run(['get', 'secret', 'vibecarbon-tls']);\n");
      expect(censusViolations(root)).toEqual([]);
      plant(
        'src/lib/rogue.js',
        "const NAME = 'vibecarbon-tls';\nawait kubectl([\n  'label',\n  'secret',\n  NAME,\n  'a=b',\n]);\n",
      );
      plant(
        'carbon/k8s/rogue.json',
        '{ "kind": "Secret", "metadata": { "name": "vibecarbon-tls" } }\n',
      );
      plant('scripts/rogue.sh', 'kubectl create secret tls vibecarbon-tls --cert=c --key=k\n');
      plant(
        'services/x/rogue.yaml',
        'apiVersion: v1\nkind: Secret\nmetadata:\n  name: vibecarbon-tls\n',
      );
      expect(censusViolations(root).sort()).toEqual(
        [
          'carbon/k8s/rogue.json:1',
          'scripts/rogue.sh:1',
          'services/x/rogue.yaml:2',
          'src/lib/rogue.js:3',
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
