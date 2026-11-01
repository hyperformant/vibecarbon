/**
 * Census: every call site that puts the app image on a node, for every tier
 * (k8s-ha registry copy plan, Task 7, rulings R5 and R7; cold-deploy-speed
 * plan, Task 4, ruling R2).
 *
 * The pilot-light standby must never get its image from the operator: it
 * receives it from the primary's registry over wg0 (copyAppImageToStandby).
 * A new call to any of the delivery primitives is therefore a decision point:
 * can a standby reach it? This test fails on any call site not in the table
 * below, so that decision cannot be skipped.
 *
 * Calls are found with vite's parseAst over every `.js` file under `src/`, so
 * comments never count. A call counts whether the callee is the bare name or a
 * member (`d.buildAppImage(`, `deps.deliverImage(`), on any object. Each site is
 * keyed `file:enclosingFunction` (nearest named function).
 *
 * The second describe holds the transport itself: no string in src/ spells a
 * whole-image `docker save` / `docker load` / `ctr images import` outside the
 * layer delta (layer-delta.js and its target half, layer-delta-remote.sh, which
 * is not a .js file and so is never walked). A whole-image send is the 562 s
 * cold compose transfer and the 629 s + 523 s k8s sideload and registry push
 * this census exists to keep gone.
 *
 * The cold-deploy-speed plan's Task 5 deleted sideloadK3s,
 * pushImageToLocalRegistry and pushImageOverSshTunnel: k8s delivers once, by
 * layer delta, into the master's registry, and every node pulls from it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = join(REPO, 'src');
const PRIMITIVES = new Set(['deliverImage', 'buildAppImage', 'copyAppImageToStandby']);

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

/** file:fn site -> primitives called there, with the reason a standby cannot (or does) reach it. */
const SITES: Record<string, { calls: string[]; why: string; gated?: boolean }> = {
  'lib/deploy/k8s/k3s.js:deliverAppImage': {
    calls: ['buildAppImage'],
    gated: true,
    why: 'primary only: planImageDelivery returns no build for role standby',
  },
  'lib/deploy/k8s/k3s.js:startAppImageBuild': {
    calls: ['buildAppImage'],
    gated: true,
    why: 'primary only: the same build, started before provisioning; planImageDelivery returns no build for role standby',
  },
  'lib/deploy/k8s/k3s.js:applyK3sManifests': {
    calls: ['deliverImage'],
    gated: true,
    why: 'primary only: planImageDelivery deliver is false for role standby',
  },
  'lib/deploy/effects/index.js:transferImage': {
    calls: ['deliverImage'],
    why: 'compose tier, not k8s; single compose only (compose-ha builds natively on both servers); one layer delta per deploy',
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

/**
 * `import { copyAppImageToStandby as ship }` would hide every call from the name match
 * above, so a rename of a primitive on import is itself a finding.
 */
function findAliasedImports(path: string, text: string): string[] {
  const out: string[] = [];
  const flag = (imported: string, local: string | undefined) => {
    if (PRIMITIVES.has(imported) && local !== imported) {
      out.push(`${path}: ${imported} imported as ${local}`);
    }
  };
  walk(parseAst(text), (n) => {
    if (n.type === 'ImportSpecifier') {
      flag(n.imported?.name ?? n.imported?.value, n.local?.name);
      return;
    }
    // `const { deliverImage: send } = await import('./layer-delta.js')`: the
    // file's lazy-import convention renames by destructuring, not a specifier.
    if (n.type !== 'VariableDeclarator' || n.id?.type !== 'ObjectPattern') return;
    const init = n.init?.type === 'AwaitExpression' ? n.init.argument : n.init;
    if (init?.type !== 'ImportExpression') return;
    for (const prop of n.id.properties) {
      if (prop.type !== 'Property' || prop.computed) continue;
      const imported = prop.key?.name ?? prop.key?.value;
      const target = prop.value?.type === 'AssignmentPattern' ? prop.value.left : prop.value;
      flag(imported, target?.name);
    }
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

describe('image-delivery call-site census', () => {
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

  it('positive control: the walk sees at least the classified sites', () => {
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

/** A whole-image save or load: the transport only the layer delta may spell. */
const WHOLE_IMAGE = /\bdocker (image )?(save|load)\b|\bctr\b.*\bimages import\b/;

const SAVE_OR_LOAD = new Set(['save', 'load']);

/** The leading string elements of an argv array, up to the first non-string. */
function leadingStrings(elements: Node[]): string[] {
  const out: string[] = [];
  for (const el of elements) {
    if (el?.type !== 'Literal' || typeof el.value !== 'string') break;
    out.push(el.value);
  }
  return out;
}

/** `docker save`/`docker image load` as argv words, whatever splits them. */
function isDockerSaveLoadArgv(words: string[]): boolean {
  if (words[0] !== 'docker') return false;
  const verb = words[1] === 'image' ? words[2] : words[1];
  return SAVE_OR_LOAD.has(verb);
}

/** Where a whole-image save or load may still be spelled, by file or by file:function. */
const WHOLE_IMAGE_EXEMPT = new Set(['lib/deploy/layer-delta.js']);

/** Named functions enclosing a node, nearest first ('<module>' when none). */
function enclosingFnNames(ancestors: Node[]): string[] {
  const names: string[] = [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isFn(ancestors[i])) continue;
    const nm = nameOfFn(ancestors[i], ancestors[i - 1]);
    if (nm) names.push(nm);
  }
  return names.length ? names : ['<module>'];
}

const stringValue = (n: Node): string | null => {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') {
    return n.quasis.map((q: Node) => q.value.cooked ?? q.value.raw).join('');
  }
  // ['docker', 'save', tag] handed to runCommandAsync / execFile.
  if (n.type === 'ArrayExpression') {
    const words = leadingStrings(n.elements);
    return isDockerSaveLoadArgv(words) ? words.join(' ') : null;
  }
  // spawn('docker', ['load', ...]): the command and its argv are two arguments.
  if (n.type === 'CallExpression' && n.arguments[1]?.type === 'ArrayExpression') {
    const head = n.arguments[0];
    if (head?.type !== 'Literal' || typeof head.value !== 'string') return null;
    const words = [head.value, ...leadingStrings(n.arguments[1].elements)];
    return isDockerSaveLoadArgv(words) ? words.join(' ') : null;
  }
  return null;
};

/**
 * String literals and templates that spell a whole-image save or load, keyed
 * file:nearestFunction. A site inside an exempt function (at any depth, so an
 * inner arrow counts as its named parent) is skipped.
 */
function findWholeImageStrings(path: string, text: string): string[] {
  const out: string[] = [];
  walk(parseAst(text), (n, ancestors) => {
    const value = stringValue(n);
    if (value === null || !WHOLE_IMAGE.test(value)) return;
    const names = enclosingFnNames(ancestors);
    if (WHOLE_IMAGE_EXEMPT.has(path)) return;
    if (names.some((nm) => WHOLE_IMAGE_EXEMPT.has(`${path}:${nm}`))) return;
    out.push(`${path}:${names[0]}: ${value.slice(0, 80)}`);
  });
  return out;
}

describe('only the layer delta ships a whole image', () => {
  it('no string in src/ spells docker save, docker load or ctr images import outside it', () => {
    const found = jsFiles(SRC).flatMap((abs) =>
      findWholeImageStrings(relative(SRC, abs), readFileSync(abs, 'utf-8')),
    );
    expect(found, 'deliver the image with deliverImage (layer-delta.js)').toEqual([]);
  });

  it('positive control: the layer delta itself spells one, so the walk can see it', () => {
    const delta = readFileSync(join(SRC, 'lib/deploy/layer-delta.js'), 'utf-8');
    const chains: string[][] = [];
    walk(parseAst(delta), (n, ancestors) => {
      const v = stringValue(n);
      if (v !== null && WHOLE_IMAGE.test(v)) chains.push(enclosingFnNames(ancestors));
    });
    expect(chains.some((c) => c.includes('saveImageToDir'))).toBe(true);
  });
});

describe('image-delivery primitives are never imported under another name', () => {
  it('no file in src/ aliases one', () => {
    const aliased = jsFiles(SRC).flatMap((abs) =>
      findAliasedImports(relative(SRC, abs), readFileSync(abs, 'utf-8')),
    );
    expect(aliased).toEqual([]);
  });
});

describe('planted fixtures', () => {
  it('flags a primitive imported under another name', () => {
    expect(
      findAliasedImports(
        'f.js',
        "import { copyAppImageToStandby as ship, other } from './image-copy.js';",
      ),
    ).toEqual(['f.js: copyAppImageToStandby imported as ship']);
  });

  it('flags a primitive renamed while destructuring a dynamic import', () => {
    const text = [
      "async function a() { const { deliverImage: send } = await import('./layer-delta.js'); }",
      "async function b() { const { copyAppImageToStandby: s = null, other: o } = await import('./k3s.js'); }",
      "async function c() { const { deliverImage } = await import('./layer-delta.js'); }",
    ].join('\n');
    expect(findAliasedImports('f.js', text)).toEqual([
      'f.js: deliverImage imported as send',
      'f.js: copyAppImageToStandby imported as s',
    ]);
  });

  it('accepts a plain import, an unrelated alias, and an export-only rename', () => {
    expect(
      findAliasedImports(
        'f.js',
        "import { copyAppImageToStandby, buildAppImage } from './k3s.js';\nimport { other as o } from './x.js';",
      ),
    ).toEqual([]);
  });

  it('flags a member call and names its enclosing function', () => {
    const s = findSites('f.js', 'async function scratch(d) { await d.copyAppImageToStandby({}); }');
    expect(s.map((x) => x.key)).toEqual(['f.js:scratch']);
  });

  it('does not count comments or strings', () => {
    expect(findSites('f.js', "// copyAppImageToStandby(x)\nconst a = 'buildAppImage(';")).toEqual(
      [],
    );
  });

  it('flags a whole-image save in a string or a template, never in a comment', () => {
    const text =
      '// docker save x | docker load\n' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      "function ship(t) { const a = 'docker load'; return `docker save ${t} | gzip`; }\n" +
      "const b = 'k3s ctr -n k8s.io images import -';";
    expect(findWholeImageStrings('f.js', text)).toEqual([
      'f.js:ship: docker load',
      'f.js:ship: docker save  | gzip',
      'f.js:<module>: k3s ctr -n k8s.io images import -',
    ]);
  });

  it('flags the spellings a plain substring would miss', () => {
    const text = [
      "const a = 'docker image save x';",
      "const b = 'k3s ctr --address /run/x -n k8s.io images import -';",
      "function argv(t) { return runCommandAsync(['docker', 'save', t]); }",
      "function child(t) { return spawn('docker', ['image', 'load', '-i', t]); }",
    ].join('\n');
    expect(findWholeImageStrings('f.js', text)).toEqual([
      'f.js:<module>: docker image save x',
      'f.js:<module>: k3s ctr --address /run/x -n k8s.io images import -',
      'f.js:argv: docker save',
      'f.js:child: docker image load -i',
    ]);
  });

  it('leaves other docker argv alone', () => {
    const text =
      "runCommandAsync(['docker', 'tag', a, b]); spawn('docker', ['build', '-t', t]); const s = 'docker saved';";
    expect(findWholeImageStrings('f.js', text)).toEqual([]);
  });

  it('exempts the layer delta file only: a k8s sideload is a finding again', () => {
    const text =
      "function sideloadK3s() { const runOnce = () => 'docker save x'; return runOnce(); }\n" +
      "function other() { return 'docker load'; }";
    expect(findWholeImageStrings('lib/deploy/layer-delta.js', text)).toEqual([]);
    expect(findWholeImageStrings('lib/deploy/k8s/k3s.js', text)).toEqual([
      'lib/deploy/k8s/k3s.js:runOnce: docker save x',
      'lib/deploy/k8s/k3s.js:other: docker load',
    ]);
  });
});
