/**
 * Census: every version-gated feature we use has a row in the floors table, and
 * every row still names a feature we use.
 *
 * The floors table (src/lib/runtime-floors.js) only protects what it lists. The
 * failure it prevents is Docker 27.5.1 meeting `docker save --platform` deep in
 * a deploy, so a gated feature with no row is the same bug waiting. A row whose
 * feature has gone is the other half: a floor nothing needs still refuses
 * customers. `kubectl 1.27` was exactly that, a floor kept for a reason that was
 * no longer true.
 *
 * Each pattern is one feature's use in code, comments excluded, so a remark
 * about a flag does not keep its row alive.
 *
 * Section C of the audit lists twenty items. Held here: 1, 3 to 8, 10 to 14 and
 * 16. Not held, because no pattern could mean anything:
 *   2   the unpinned docker-ce install is a policy, not a feature; the floors
 *       and the scheduled newest-Docker workflow are what answer it.
 *   9   kubectl skew is a relation between two versions, judged live
 *       (kubectlSkewWarning).
 *   15  flags present in every k3s we could install.
 *   17  binfmt is a hint, and its image is pinned.
 *   18  `wg` comes with the OS image, and its output format has not moved.
 *   19  the Postgres tools are pinned inside our own image.
 *   20  nothing in the tree uses openssl.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error: untyped JS module
import { RUNTIME_FLOORS } from '../../../src/lib/runtime-floors.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ROOTS = ['src', 'carbon', 'services'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next', 'build']);
const EXTS = /\.(?:js|mjs|sh|ya?ml)$|(?:^|\/)Dockerfile[^/]*$/;
/** The table describes every feature in words, so it cannot be evidence of one. */
const THE_TABLE = 'src/lib/runtime-floors.js';

type Gate = { pattern: RegExp; in?: RegExp };
type Tree = Record<string, string>;

const COMPOSE_FILES = /docker-compose[^/]*\.ya?ml$/;

/** Row id to the feature's use in code. One entry per row, no exceptions. */
const GATES: Record<string, Gate> = {
  'engine-start-interval': { pattern: /^\s*start_interval:/m, in: COMPOSE_FILES },
  'engine-save-platform': { pattern: /save_cmd --platform/ },
  'engine-buildkit': { pattern: /^\s*RUN --mount=/m, in: /Dockerfile/ },
  'compose-merge-tags': { pattern: /!(?:reset|override)\b/, in: COMPOSE_FILES },
  'compose-config-content': { pattern: /^\s+content: [|>]/m, in: COMPOSE_FILES },
  'compose-pull-policy': { pattern: /\bpull\b[^\n]*--policy missing/ },
  'compose-wait-timeout': { pattern: /--wait-timeout\b/ },
  'compose-ps-json-lines': { pattern: /'compose', 'ps', '--format', 'json'/ },
  'kubectl-patch-subresource': { pattern: /--subresource=status/ },
  'kubectl-kustomize-url': { pattern: /\[\s*'kustomize'\s*,/ },
  'ssh-accept-new': { pattern: /StrictHostKeyChecking=accept-new/ },
  'ssh-askpass-require': { pattern: /\bSSH_ASKPASS_REQUIRE\b/ },
  'pulumi-backend-checksum': { pattern: /&request_checksum_calculation=/ },
  'pulumi-worker-trigger': { pattern: /\breplacementTrigger:/ },
  'node-engines': { pattern: /\bparseEnv\(/ },
  'k3s-registry-endpoint': { pattern: /--disable-default-registry-endpoint\b/ },
};

/** Whole-line comments gone, so a remark about a flag is not a use of it. */
function code(text: string, file: string): string {
  const js = /\.m?js$/.test(file);
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (js) return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      return !t.startsWith('#');
    })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.test(name)) out.push(p);
  }
  return out;
}

function realTree(): Tree {
  const tree: Tree = {};
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const rel = relative(ROOT, file);
      if (rel !== THE_TABLE) tree[rel] = code(readFileSync(file, 'utf8'), rel);
    }
  }
  return tree;
}

const usedIn = (gate: Gate, tree: Tree) =>
  Object.keys(tree).filter((f) => (!gate.in || gate.in.test(f)) && gate.pattern.test(tree[f]));

function audit(gates: Record<string, Gate>, rowIds: string[], tree: Tree): string[] {
  const problems: string[] = [];
  for (const [id, gate] of Object.entries(gates)) {
    const files = usedIn(gate, tree);
    if (files.length > 0 && !rowIds.includes(id)) {
      problems.push(`${id} is used in ${files[0]} and has no row in the floors table`);
    }
  }
  for (const id of rowIds) {
    if (!gates[id]) problems.push(`${id} has a row and no pattern here to hold it`);
    else if (usedIn(gates[id], tree).length === 0) {
      problems.push(`${id} has a row, but its feature is no longer used anywhere`);
    }
  }
  return problems;
}

describe('runtime floors census', () => {
  const tree = realTree();
  const rowIds: string[] = RUNTIME_FLOORS.map((row: { id: string }) => row.id);

  it('walks the tree it means to', () => {
    expect(Object.keys(tree).some((f) => f.startsWith('src/'))).toBe(true);
    expect(Object.keys(tree).some((f) => f.startsWith('carbon/'))).toBe(true);
    expect(Object.keys(tree).some((f) => f.startsWith('services/'))).toBe(true);
    expect(tree[THE_TABLE]).toBeUndefined();
  });

  it('every gated feature in use has a row, and every row has a feature in use', () => {
    expect(audit(GATES, rowIds, tree)).toEqual([]);
  });

  describe('the audit itself', () => {
    const gates: Record<string, Gate> = { 'a-flag': { pattern: /--a-flag/ } };

    it('fails on a feature in use with no row', () => {
      expect(audit(gates, [], { 'src/x.js': "run('--a-flag')" })).toEqual([
        'a-flag is used in src/x.js and has no row in the floors table',
      ]);
    });

    it('fails on a row whose feature has gone', () => {
      expect(audit(gates, ['a-flag'], { 'src/x.js': 'nothing' })).toEqual([
        'a-flag has a row, but its feature is no longer used anywhere',
      ]);
    });

    it('fails on a row nothing here holds', () => {
      expect(audit(gates, ['a-flag', 'new-row'], { 'src/x.js': '--a-flag' })).toEqual([
        'new-row has a row and no pattern here to hold it',
      ]);
    });

    it('does not count a comment as a use', () => {
      const text = "// mentions --a-flag\n * and --a-flag\nrun('other')";
      expect(code(text, 'src/x.js')).not.toContain('--a-flag');
      expect(code('# --a-flag\nkey: value', 'a.yml')).not.toContain('--a-flag');
    });

    it('keeps a pattern to the files it is about', () => {
      const scoped = { 'a-flag': { pattern: /--a-flag/, in: /\.yml$/ } };
      expect(usedIn(scoped['a-flag'], { 'src/x.js': '--a-flag' })).toEqual([]);
    });
  });
});
