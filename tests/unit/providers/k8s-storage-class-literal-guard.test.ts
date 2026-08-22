/**
 * M3 Task 4: k8s manifests that provision a PersistentVolumeClaim must
 * route their StorageClass through `{{K8S_STORAGE_CLASS}}` (resolved at
 * DEPLOY time by `renderK8sStorageClassPlaceholder` in k3s.js — a pre-apply
 * render into a temp kustomize copy, because PVC storageClassName is
 * immutable post-create so no kubectl patch can fix it later, and `add`-time
 * baking is impossible since the provider is only resolved per-environment
 * at deploy) instead of hardcoding any provider's StorageClass literal. A
 * reintroduced hardcode would silently break every OTHER provider's
 * observability/n8n PVCs (their CSI drivers have no such StorageClass to
 * bind against). Generalized 2026-08-07: the guard iterates PROVIDERS and
 * bans EACH provider's K8S_STORAGE_CLASS literal outside its own file —
 * until then only Hetzner's `hcloud-volumes` was guarded, an asymmetry that
 * left `do-block-storage` (and every future provider's literal) unswept.
 *
 * Two static-source recall checks, same "read the whole file as one string"
 * approach as hcloud-ca-retirement-guard.test.ts /
 * no-hardcoded-provider-dispatch.test.ts:
 *
 *   1. k8s manifests (carbon/k8s/, services/) — the literal must not appear
 *      AT ALL (bare YAML scalar, no quotes). Walked directly (not via
 *      src/lib/providers/) so this never needs to know where the sanctioned
 *      static lives.
 *   2. src/ JS source — the literal must appear ONLY as the quoted string
 *      value inside HetznerProvider.K8S_STORAGE_CLASS (hetzner.js). The
 *      pattern requires actual quotes so it does NOT flag the backtick-
 *      wrapped doc-comment cross-references in base.js/digitalocean.js
 *      (`` `hcloud-volumes` ``) — those are legitimate documentation, not a
 *      hardcoded value a runtime path could read.
 *
 * carbon/node_modules is deliberately NOT walked (mirrors
 * hcloud-ca-retirement-guard.test.ts's carbon/k8s/-scoped root, not all of
 * carbon/) — it's a local dev install, not a shipped/checked-in tree, and
 * walking it would make this test both slow and meaningless.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

const CARBON_K8S_ROOT = join(process.cwd(), 'carbon', 'k8s');
const SERVICES_ROOT = join(process.cwd(), 'services');
const SRC_ROOT = join(process.cwd(), 'src');

// One row per registered provider: its sanctioned StorageClass literal and
// the ONE file allowed to carry it. Derived from the registry (2026-08-07
// test-architecture audit) — until then only Hetzner's `hcloud-volumes` was
// guarded, so a hardcode of DO's `do-block-storage` (or any future
// provider's literal) would have shipped unswept.
const PROVIDER_ROWS: Array<[string, string, string]> = Object.entries(PROVIDERS).map(
  ([id, Provider]) => [
    id,
    Provider.K8S_STORAGE_CLASS,
    join(SRC_ROOT, 'lib', 'providers', `${id}.js`),
  ],
);
// carbon/k8s/overlays/local/ is a kind/minikube dev overlay, out of scope
// for M3 (it already hardcodes `local-path` for ALL providers via its own
// kustomize patch — never `hcloud-volumes` as a live value). Its test
// driver script documents that swap in a `#` comment, which the bare-word
// pattern below can't distinguish from a real manifest value the way the
// quoted-string pattern distinguishes JS doc comments (no backtick
// convention in shell comments) — so it's exempted by path, same as the
// EXEMPT_DIR precedent in no-hardcoded-provider-dispatch.test.ts.
const LOCAL_OVERLAY_TEST_SCRIPT = join(CARBON_K8S_ROOT, 'test-local.sh');

const bareLiteralPattern = (literal: string) => new RegExp(`\\b${literal}\\b`);
const quotedLiteralPattern = (literal: string) => new RegExp(`['"]${literal}['"]`);

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function walkJsFiles(dir: string): string[] {
  return walkFiles(dir).filter((f) => f.endsWith('.js'));
}

describe.each(PROVIDER_ROWS)(
  'no hardcoded %s StorageClass literal (%s) outside its own provider file',
  (_id, literal, homeFile) => {
    it('k8s manifests (carbon/k8s/, services/) never hardcode the bare scalar', () => {
      const files = [...walkFiles(CARBON_K8S_ROOT), ...walkFiles(SERVICES_ROOT)].filter(
        (f) => f !== LOCAL_OVERLAY_TEST_SCRIPT,
      );
      expect(files.length).toBeGreaterThan(50); // sanity: the walk actually found the trees

      const offenders: Array<{ file: string; match: string }> = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const match = content.match(bareLiteralPattern(literal));
        if (match) {
          offenders.push({ file: file.replace(`${process.cwd()}${sep}`, ''), match: match[0] });
        }
      }

      expect(offenders).toEqual([]);
    });

    it('src/ never hardcodes the quoted string outside the provider file', () => {
      const files = walkJsFiles(SRC_ROOT).filter((f) => f !== homeFile);
      expect(files.length).toBeGreaterThan(50); // sanity: the walk actually found the tree

      const offenders: Array<{ file: string; match: string }> = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const match = content.match(quotedLiteralPattern(literal));
        if (match) {
          offenders.push({ file: file.replace(`${process.cwd()}${sep}`, ''), match: match[0] });
        }
      }

      expect(offenders).toEqual([]);

      // The provider's own file must still carry the sanctioned static — an
      // empty exemption list would let this whole guard pass vacuously if
      // the static were ever deleted outright.
      expect(readFileSync(homeFile, 'utf-8')).toMatch(quotedLiteralPattern(literal));
    });
  },
);

describe('storage-class guard population', () => {
  it('every registered provider declares a distinct K8S_STORAGE_CLASS (not vacuously green)', () => {
    expect(PROVIDER_ROWS.length).toBeGreaterThanOrEqual(2);
    const literals = PROVIDER_ROWS.map(([, literal]) => literal);
    expect(new Set(literals).size).toBe(literals.length);
  });

  // Positive control: proves both pattern factories actually catch a
  // reintroduced hardcode (bare YAML scalar AND quoted JS string) and don't
  // flag the backtick-wrapped doc-comment cross-references that legitimately
  // mention the value for documentation (base.js, digitalocean.js).
  it('pattern control: bare + quoted forms match, backtick doc comments do not', () => {
    for (const literal of ['hcloud-volumes', 'do-block-storage']) {
      const yamlLine = `  storageClassName: ${literal}`;
      const jsAssignment = `  static K8S_STORAGE_CLASS = '${literal}';`;
      const jsDoubleQuoted = `  const x = "${literal}";`;
      const docComment = `   * default (e.g. Hetzner's \`${literal}\`, DigitalOcean's`;
      const placeholder = '  storageClassName: {{K8S_STORAGE_CLASS}}';

      expect(bareLiteralPattern(literal).test(yamlLine)).toBe(true);
      expect(bareLiteralPattern(literal).test(placeholder)).toBe(false);

      expect(quotedLiteralPattern(literal).test(jsAssignment)).toBe(true);
      expect(quotedLiteralPattern(literal).test(jsDoubleQuoted)).toBe(true);
      expect(quotedLiteralPattern(literal).test(docComment)).toBe(false);
    }
  });
});
