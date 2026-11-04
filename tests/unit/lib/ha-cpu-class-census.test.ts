/**
 * Census: every HA size decision routes through the common-class pickers in
 * src/lib/sizing.js (haRoleSets, haStandbyType, haDefaultPair), never a
 * price-only standby resolution.
 *
 * The two price-only resolvers are `Provider.resolveServerTypeForRegion` (the
 * primary's type where stocked, else the cheapest stand-in of at least its
 * RAM) and `standbyStandIn` (that stand-in). Used directly for an HA standby
 * they place it by price alone, which is how an sfo3 -amd primary got a
 * regular tor1 standby that took twice as long to install (owner decision
 * 2026-11-03). Only the pickers may call them: sizing.js (haStandbyType
 * delegates to the provider's resolver where the class rule does not apply)
 * and the provider classes, whose resolveServerTypeForRegion is built on
 * standbyStandIn.
 *
 * Rule: no file in `src/`, `scripts/` or `tests/e2e/` other than
 * src/lib/sizing.js and src/lib/providers/ uses either one: a call, a
 * member read (`P.resolveServerTypeForRegion`, `P['resolveServerTypeForRegion']`,
 * `S.standbyStandIn` off a namespace import), a destructure (off an object
 * or a dynamic import), an import or re-export of `standbyStandIn` (and a
 * wildcard re-export of sizing.js), or a value handed on under another name
 * (followed through aliases and seam defaults). And each HA path
 * calls its picker: both deploy effects, the standby resolution they share,
 * the deploy wizard, the cost grid and the e2e capacity resolver.
 *
 * Structure follows configure-standby-replication-callers-census.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const RESOLVER = 'resolveServerTypeForRegion';
const STAND_IN = 'standbyStandIn';

/** The pickers themselves and the provider implementations they delegate to. */
const EXEMPT = (path: string) =>
  path === 'src/lib/sizing.js' || path.startsWith('src/lib/providers/');

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

/** Visit every ESTree node with its parent and the key it hangs off. */
function walk(
  node: Node,
  fn: (n: Node, parent: Node | null, key: string | null) => void,
  parent: Node | null = null,
  key: string | null = null,
) {
  fn(node, parent, key);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const children = Array.isArray(v) ? v : [v];
    for (const child of children) {
      if (child && typeof child === 'object' && typeof child.type === 'string') {
        walk(child, fn, node, k);
      }
    }
  }
}

function parse(path: string, text: string): Node {
  return parseAst(text, { lang: path.endsWith('.ts') ? 'ts' : 'js' } as never);
}

/** The name an `alias = <expr>` binding gives the node at `key` of `parent`. */
function boundNameOf(parent: Node | null, key: string | null): string | null {
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && key === 'init' && parent.id?.type === 'Identifier') {
    return parent.id.name;
  }
  if (
    parent.type === 'AssignmentPattern' &&
    key === 'right' &&
    parent.left?.type === 'Identifier'
  ) {
    return parent.left.name;
  }
  if (
    parent.type === 'AssignmentExpression' &&
    key === 'right' &&
    parent.left?.type === 'Identifier'
  ) {
    return parent.left.name;
  }
  return null;
}

/** An identifier in a non-use position: specifier, declaration, binding or property key. */
function isDeclarationPosition(parent: Node | null, key: string | null): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return true;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return key === 'id' || key === 'params';
    case 'ArrowFunctionExpression':
      return key === 'params';
    case 'VariableDeclarator':
      return key === 'id';
    case 'AssignmentPattern':
      return key === 'left';
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key === 'key' && !parent.computed;
    case 'MemberExpression':
      return key === 'property' && !parent.computed;
    default:
      return false;
  }
}

/** Both price-only resolvers, by the name they are read under. */
const PRICE_ONLY = new Set([RESOLVER, STAND_IN]);

/** The name an identifier-or-string node carries (`foo`, or `'foo'` in an export). */
const nameOf = (n: Node): string | undefined => n?.name ?? n?.value;

/**
 * Is `n` a read of a price-only resolver off an object: `P.resolve…`,
 * `P['resolve…']`, or the stand-in off a namespace import or a dynamic
 * import's module (`S.standbyStandIn`)?
 */
function isPriceOnlyMember(n: Node): boolean {
  if (n.type !== 'MemberExpression') return false;
  if (!n.computed) return n.property?.type === 'Identifier' && PRICE_ONLY.has(n.property.name);
  return n.property?.type === 'Literal' && PRICE_ONLY.has(n.property.value);
}

/** Is `n` a re-export that hands the stand-in on: `export { standbyStandIn } from`, `export * from '…/sizing.js'`? */
function isPriceOnlyReexport(n: Node): boolean {
  if (n.type === 'ExportNamedDeclaration' && n.source) {
    return n.specifiers.some((sp: Node) => nameOf(sp.local) === STAND_IN);
  }
  return n.type === 'ExportAllDeclaration' && /(^|\/)sizing(\.js)?$/.test(n.source?.value ?? '');
}

/** Uses of a price-only resolver in `text`, as sorted unique `path:line`. */
function findPriceOnlyUses(path: string, text: string): string[] {
  const ast = parse(path, text);
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
  const hits = new Set<number>();
  const names = new Set([STAND_IN]);

  walk(ast, (n, parent, key) => {
    // An import of the stand-in, under any local name.
    if (n.type === 'ImportSpecifier' && n.imported?.name === STAND_IN) {
      names.add(n.local.name);
      hits.add(lineOf(n.start));
    }
    // A re-export hands it on to files the census would then miss.
    if (isPriceOnlyReexport(n)) hits.add(lineOf(n.start));
    // A read off an object or a namespace; a binding takes its alias along.
    if (isPriceOnlyMember(n)) {
      hits.add(lineOf(n.start));
      const bound = boundNameOf(parent, key);
      if (bound) names.add(bound);
    }
    // `{ resolveServerTypeForRegion }`, `{ standbyStandIn: s }` off an object or a module.
    if (
      n.type === 'Property' &&
      parent?.type === 'ObjectPattern' &&
      !n.computed &&
      PRICE_ONLY.has(n.key?.name)
    ) {
      hits.add(lineOf(n.start));
      const target = n.value?.type === 'AssignmentPattern' ? n.value.left : n.value;
      if (target?.type === 'Identifier') names.add(target.name);
    }
  });

  // Follow `alias = <name>` bindings (seam defaults, consts) to a fixpoint.
  for (let grew = true; grew; ) {
    grew = false;
    walk(ast, (n, parent, key) => {
      if (n.type !== 'Identifier' || !names.has(n.name)) return;
      const bound = boundNameOf(parent, key);
      if (bound && !names.has(bound)) {
        names.add(bound);
        grew = true;
      }
    });
  }

  walk(ast, (n, parent, key) => {
    if (n.type !== 'Identifier' || !names.has(n.name)) return;
    if (isDeclarationPosition(parent, key)) return;
    hits.add(lineOf(n.start));
  });
  return [...hits].sort((a, b) => a - b).map((line) => `${path}:${line}`);
}

/** Calls of the exported `name` in `text`, under its imported alias too. */
function callsOf(path: string, text: string, name: string): number {
  const ast = parse(path, text);
  const local = new Set([name]);
  walk(ast, (n) => {
    if (n.type === 'ImportSpecifier' && n.imported?.name === name) local.add(n.local.name);
  });
  let calls = 0;
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && local.has(n.callee.name)) {
      calls++;
    }
  });
  return calls;
}

function walkedFiles() {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'tests/e2e'],
    { cwd: REPO, encoding: 'utf-8' },
  );
  return listed
    .split('\n')
    .filter((f) => /\.(m?js|ts)$/.test(f))
    .map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf-8') }));
}

const read = (path: string) => readFileSync(join(REPO, path), 'utf-8');

describe('HA sizes census: no price-only standby resolution outside the pickers', () => {
  const files = walkedFiles();

  it('walks src/, scripts/ and tests/e2e/', () => {
    const roots = new Set(files.map(({ path }) => path.split('/').slice(0, 2).join('/')));
    expect([...roots]).toEqual(
      expect.arrayContaining(['src/cli.js', 'src/lib', 'scripts/cost-grid.js', 'tests/e2e']),
    );
  });

  it('no file outside sizing.js and the providers uses resolveServerTypeForRegion or standbyStandIn', () => {
    const offenders = files
      .filter(({ path }) => !EXEMPT(path))
      .flatMap(({ path, text }) => findPriceOnlyUses(path, text));
    expect(offenders).toEqual([]);
  });

  it('the census sees the real users (sizing.js and the providers), so an empty result means something', () => {
    const users = files
      .filter(({ path, text }) => findPriceOnlyUses(path, text).length > 0)
      .map(({ path }) => path);
    expect(users).toEqual(
      expect.arrayContaining([
        'src/lib/sizing.js',
        'src/lib/providers/digitalocean.js',
        'src/lib/providers/hetzner.js',
      ]),
    );
  });

  it.each([
    ['src/lib/deploy/effects/compose-ha.js', ['haStandbyType', 'haClassMessage']],
    ['src/lib/deploy/effects/k8s-ha.js', ['k8sStandbyTypes', 'haClassMessage']],
    ['src/lib/deploy/standby-types.js', ['haStandbyType']],
    [
      'src/lib/deploy/prompts.js',
      ['haRoleSets', 'haStandbyType', 'haDefaultPair', 'k8sStandbyTypes'],
    ],
    ['scripts/cost-grid.js', ['haDefaultPair']],
    ['tests/e2e/utils/region-resolver.ts', ['haRoleSets']],
  ])('%s sizes HA through %j', (path, pickers) => {
    for (const picker of pickers) {
      expect(callsOf(path, read(path), picker), `${path} calls ${picker}`).toBeGreaterThan(0);
    }
  });

  describe('planted fixtures', () => {
    it('flags a direct call on a provider class', () => {
      const src = `export function f(P, t, r) {\n  return P.${RESOLVER}(t, r, 'compose');\n}`;
      expect(findPriceOnlyUses('x.js', src)).toEqual(['x.js:2']);
    });

    it('flags a bracket read', () => {
      const src = `const f = (P) =>\n  P['${RESOLVER}'](a, b);`;
      expect(findPriceOnlyUses('x.js', src)).toEqual(['x.js:2']);
    });

    it('follows a member read bound to an alias to its call', () => {
      const src = `const resolve = Provider.${RESOLVER};\nexport const g = () =>\n  resolve(a, b);`;
      expect(findPriceOnlyUses('x.js', src)).toEqual(['x.js:1', 'x.js:3']);
    });

    it('follows a destructure, renamed, to its call', () => {
      const src = `const { ${RESOLVER}: pick } = Provider;\n\nexport const g = () => pick(a);`;
      expect(findPriceOnlyUses('x.js', src)).toEqual(['x.js:1', 'x.js:3']);
    });

    it('follows an import alias of the stand-in and a seam default to the call', () => {
      const src =
        `import { ${STAND_IN} as standIn } from './sizing.js';\n` +
        'export function f(P, { place = standIn } = {}) {\n' +
        "  return place(P, 't', 'r');\n}";
      expect(findPriceOnlyUses('x.js', src)).toEqual(['x.js:1', 'x.js:2', 'x.js:3']);
    });

    it('flags the stand-in read off a namespace import', () => {
      const src =
        "import * as S from '../sizing.js';\n" +
        'export function f(P, t, r) {\n' +
        "  return S.standbyStandIn(P, t, r, 'compose');\n}";
      expect(findPriceOnlyUses('x.js', src)).toEqual(['x.js:3']);
    });

    it('flags the stand-in destructured off a dynamic import, and its call', () => {
      const src =
        "const { standbyStandIn: s } = await import('./sizing.js');\n" +
        'export const f = () =>\n  s(P, t, r);';
      expect(findPriceOnlyUses('x.js', src)).toEqual(['x.js:1', 'x.js:3']);
    });

    it('flags a re-export of the stand-in, plain or renamed', () => {
      expect(findPriceOnlyUses('x.js', "export { standbyStandIn } from './sizing.js';")).toEqual([
        'x.js:1',
      ]);
      expect(
        findPriceOnlyUses('x.js', "\nexport { standbyStandIn as pick } from '../sizing.js';"),
      ).toEqual(['x.js:2']);
    });

    it('flags a wildcard re-export of sizing.js, and passes one of another module', () => {
      expect(findPriceOnlyUses('x.js', "export * from '../lib/sizing.js';")).toEqual(['x.js:1']);
      expect(findPriceOnlyUses('x.js', "export * from './colors.js';")).toEqual([]);
    });

    it('reads TypeScript', () => {
      const src = `const x: string | null =\n  Provider.${RESOLVER}(type as string, region, 'db');`;
      expect(findPriceOnlyUses('x.ts', src)).toEqual(['x.ts:2']);
    });

    it('passes the picker and a comment that names the resolver', () => {
      const src =
        `// once Provider.${RESOLVER} placed this by price alone\n` +
        "import { haStandbyType } from './sizing.js';\n" +
        "export const f = (P, t, r) => haStandbyType(P, t, r, 'compose');";
      expect(findPriceOnlyUses('x.js', src)).toEqual([]);
    });

    it('callsOf counts a call under an import alias, and not a bare mention', () => {
      const src =
        "import { haRoleSets as pair } from './sizing.js';\n" +
        'export const f = () => pair(P, a, b, roles);\n' +
        'export const g = haStandbyType;';
      expect(callsOf('x.js', src, 'haRoleSets')).toBe(1);
      expect(callsOf('x.js', src, 'haStandbyType')).toBe(0);
    });
  });
});
