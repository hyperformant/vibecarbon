/**
 * Census: every call site that puts the app image on a node (k8s-ha registry
 * copy plan, Task 7, rulings R5 and R7).
 *
 * The pilot-light standby must never get its image from the operator: it
 * receives it from the primary's registry over wg0 (copyAppImageToStandby).
 * A new call to any of the delivery primitives is therefore a decision point:
 * can a standby reach it? This test fails on any call site not in the table
 * below, so that decision cannot be skipped.
 *
 * Calls are found with vite's parseAst over every `.js` file under `src/`, so
 * comments never count. A call counts whether the callee is the bare name or a
 * member (`d.buildAppImage(`, `deps.sideloadK3s(`), on any object. Each site is
 * keyed `file:enclosingFunction` (nearest named function).
 *
 * The cold-deploy-speed plan's Task 5 deletes sideloadK3s and
 * pushImageToLocalRegistry (R7). Whichever plan lands second updates SITES.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = join(REPO, 'src');
const PRIMITIVES = new Set([
  'sideloadK3s',
  'pushImageToLocalRegistry',
  'pushImageOverSshTunnel',
  'buildAppImage',
  'copyAppImageToStandby',
]);

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

/** file:fn site -> primitives called there, with the reason a standby cannot (or does) reach it. */
const SITES: Record<string, { calls: string[]; why: string; gated?: boolean }> = {
  'lib/deploy/k8s/k3s.js:deliverAppImage': {
    calls: ['buildAppImage', 'sideloadK3s'],
    gated: true,
    why: 'primary only: planImageDelivery returns no build or sideload for role standby',
  },
  'lib/deploy/k8s/k3s.js:applyK3sManifests': {
    calls: ['pushImageToLocalRegistry'],
    gated: true,
    why: 'primary only: planImageDelivery registryPush is false for role standby',
  },
  'lib/deploy/k8s/k3s.js:pushImageToLocalRegistry': {
    calls: ['pushImageOverSshTunnel'],
    why: 'thin delegate; reached only through the gated applyK3sManifests call',
  },
  'lib/deploy/effects/index.js:transferImage': {
    calls: ['pushImageOverSshTunnel'],
    why: 'compose tier, not k8s; single compose only (compose-ha builds natively on both servers); at most one push per deploy, the mutex is a guard',
  },
  'lib/deploy/effects/k8s-ha.js:startStandbyImageCopy': {
    calls: ['copyAppImageToStandby'],
    why: 'the standby image path: primary registry to standby registry over wg0',
  },
};

function walk(node: Node, fn: (n: Node, ancestors: Node[]) => void, ancestors: Node[] = []) {
  fn(node, ancestors);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    for (const child of Array.isArray(v) ? v : [v]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') {
        walk(child, fn, [...ancestors, node]);
      }
    }
  }
}

const isFn = (n: Node) =>
  n.type === 'FunctionDeclaration' ||
  n.type === 'FunctionExpression' ||
  n.type === 'ArrowFunctionExpression';

function nameOfFn(fnNode: Node, parent: Node): string | null {
  if (fnNode.id?.name) return fnNode.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key?.name) {
    return parent.key.name;
  }
  return null;
}

function calleeName(call: Node): string | null {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property?.type === 'Identifier') {
    return c.property.name;
  }
  return null;
}

type Site = { key: string; call: string; fnNode: Node | null };

function findSites(path: string, text: string): Site[] {
  const out: Site[] = [];
  walk(parseAst(text), (n, ancestors) => {
    if (n.type !== 'CallExpression') return;
    const name = calleeName(n);
    if (!name || !PRIMITIVES.has(name)) return;
    let fnName = '<module>';
    let fnNode: Node | null = null;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (!isFn(ancestors[i])) continue;
      const nm = nameOfFn(ancestors[i], ancestors[i - 1]);
      if (nm) {
        fnName = nm;
        fnNode = ancestors[i];
        break;
      }
    }
    out.push({ key: `${path}:${fnName}`, call: name, fnNode });
  });
  return out;
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

function allSites(): Site[] {
  return jsFiles(SRC).flatMap((abs) => findSites(relative(SRC, abs), readFileSync(abs, 'utf-8')));
}

describe('k8s image-delivery call-site census', () => {
  it('every call site is classified, and every classified site still exists', () => {
    const found = new Map<string, Set<string>>();
    for (const s of allSites()) {
      found.set(s.key, (found.get(s.key) ?? new Set()).add(s.call));
    }
    for (const key of found.keys()) {
      expect(
        key in SITES,
        `unclassified image-delivery call site ${key}: decide whether a standby can reach it`,
      ).toBe(true);
    }
    for (const [key, entry] of Object.entries(SITES)) {
      expect(found.has(key), `${key} no longer calls an image primitive: drop it from SITES`).toBe(
        true,
      );
      expect([...(found.get(key) ?? [])].sort()).toEqual([...entry.calls].sort());
    }
  });

  it('positive control: the walk sees at least the five classified sites', () => {
    expect(new Set(allSites().map((s) => s.key)).size).toBeGreaterThanOrEqual(
      Object.keys(SITES).length,
    );
  });

  it('each gated site calls planImageDelivery( in the same function', () => {
    for (const [key, entry] of Object.entries(SITES)) {
      if (!entry.gated) continue;
      const site = allSites().find((s) => s.key === key);
      expect(site?.fnNode, `${key} not found`).toBeTruthy();
      let gated = false;
      walk(site?.fnNode, (n) => {
        if (n.type === 'CallExpression' && calleeName(n) === 'planImageDelivery') gated = true;
      });
      expect(gated, `${key} must call planImageDelivery( to keep a standby off this path`).toBe(
        true,
      );
    }
  });
});

describe('planted fixtures', () => {
  it('flags a member call and names its enclosing function', () => {
    const s = findSites('f.js', 'async function scratch(d) { await d.sideloadK3s({}); }');
    expect(s.map((x) => x.key)).toEqual(['f.js:scratch']);
  });

  it('does not count comments or strings', () => {
    expect(findSites('f.js', "// sideloadK3s(x)\nconst a = 'buildAppImage(';")).toEqual([]);
  });
});
