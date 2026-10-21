/**
 * Census: nothing reseeds a compose-HA standby on a role-swapped env.
 *
 * C2: `configureStandbyReplication(standbyIp, primaryIp, …)` wipes the
 * target's PGDATA and basebackups it over WireGuard from 10.99.0.1, the address
 * of the node BORN as the primary. A compose failover flips only the `role`
 * fields, so on a swapped env the "standby" it targets is that same born-primary
 * node: the reseed copies the node from itself. Every caller must therefore
 * prove the env is not swapped before it reseeds.
 *
 * Rule: every use of `configureStandbyReplication` in `src/` (a call, or a
 * value handed on under another name, followed through aliases) sits in a
 * top-level function that calls `detectComposeHaRoleSwap` or
 * `assertNoComposeHaRoleSwap` earlier. The one exemption is the deploy effect
 * (effects/compose-ha.js), which only runs after the orchestrator's
 * `assertNoComposeHaRoleSwap` at the top of executeDeployment; that call is
 * asserted here too.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const NAME = 'configureStandbyReplication';
const GUARDS = new Set(['detectComposeHaRoleSwap', 'assertNoComposeHaRoleSwap']);
const DEPLOY_EFFECT = 'src/lib/deploy/effects/compose-ha.js';
const ORCHESTRATOR = 'src/lib/deploy/orchestrator.js';

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Visit every ESTree node with its parent, the key it hangs off, and its function ancestors. */
function walk(
  node: Node,
  fn: (n: Node, parent: Node | null, key: string | null, fns: Node[]) => void,
  parent: Node | null = null,
  key: string | null = null,
  fns: Node[] = [],
) {
  fn(node, parent, key, fns);
  const inner = FUNCTION_TYPES.has(node.type) ? [...fns, node] : fns;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const children = Array.isArray(v) ? v : [v];
    for (const child of children) {
      if (child && typeof child === 'object' && typeof child.type === 'string') {
        walk(child, fn, node, k, inner);
      }
    }
  }
}

/** The name an `alias = <identifier>` binding gives the identifier at `key` of `parent`. */
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
      return key === 'key' && !parent.computed;
    default:
      return false;
  }
}

/** Uses of the reseed (under any alias) not preceded by a role-swap guard in their function. */
function findUnguarded(path: string, text: string): string[] {
  const ast = parseAst(text);
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
  const names = new Set([NAME]);
  for (const st of ast.body as Node[]) {
    if (st.type !== 'ImportDeclaration') continue;
    for (const sp of st.specifiers) {
      if (sp.type === 'ImportSpecifier' && sp.imported.name === NAME) names.add(sp.local.name);
    }
  }
  // Follow `alias = <name>` bindings (seam defaults, destructures, consts) to a fixpoint.
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

  const guardCalls: Array<{ fn: Node | null; pos: number }> = [];
  walk(ast, (n, _parent, _key, fns) => {
    if (
      n.type === 'CallExpression' &&
      n.callee.type === 'Identifier' &&
      GUARDS.has(n.callee.name)
    ) {
      guardCalls.push({ fn: fns[0] ?? null, pos: n.start });
    }
  });

  const out: string[] = [];
  walk(ast, (n, parent, key, fns) => {
    if (n.type !== 'Identifier' || !names.has(n.name)) return;
    if (isDeclarationPosition(parent, key) || boundNameOf(parent, key)) return;
    const fn = fns[0] ?? null;
    const guarded = fn !== null && guardCalls.some((g) => g.fn === fn && g.pos < n.start);
    if (!guarded) out.push(`${path}:${lineOf(n.start)}`);
  });
  return out;
}

function srcFiles() {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
    { cwd: REPO, encoding: 'utf-8' },
  );
  return listed
    .split('\n')
    .filter((f) => f.endsWith('.js'))
    .map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf-8') }));
}

describe('configureStandbyReplication callers census (C2)', () => {
  it('every reseed outside the deploy effect is preceded by a role-swap guard in its function', () => {
    const offenders = srcFiles()
      .filter(({ path }) => path !== DEPLOY_EFFECT)
      .flatMap(({ path, text }) => findUnguarded(path, text));
    expect(offenders).toEqual([]);
  });

  it('the census sees the real callers (restore and failover), so an empty result means something', () => {
    const files = srcFiles();
    const callers = files
      .filter(({ text }) => text.includes(NAME))
      .map(({ path }) => path)
      .sort();
    expect(callers).toEqual(
      expect.arrayContaining(['src/lib/deploy/compose/ha.js', DEPLOY_EFFECT, 'src/restore.js']),
    );
  });

  it('the deploy effect is exempt only because the orchestrator refuses a swapped env first', () => {
    const text = readFileSync(join(REPO, ORCHESTRATOR), 'utf-8');
    let calls = 0;
    walk(parseAst(text), (n) => {
      if (
        n.type === 'CallExpression' &&
        n.callee.type === 'Identifier' &&
        n.callee.name === 'assertNoComposeHaRoleSwap'
      ) {
        calls++;
      }
    });
    expect(calls).toBeGreaterThan(0);
  });

  describe('planted fixtures', () => {
    const imp = `import { ${NAME} } from './ha.js';\n`;

    it('flags an unguarded call', () => {
      expect(
        findUnguarded('x.js', `${imp}export async function f() { await ${NAME}(a, b); }`),
      ).toEqual(['x.js:2']);
    });

    it('flags a guard that comes after the call', () => {
      const src = `${imp}export async function f(e) {\n  await ${NAME}(a, b);\n  detectComposeHaRoleSwap(e);\n}`;
      expect(findUnguarded('x.js', src)).toEqual(['x.js:3']);
    });

    it('passes a call after the guard', () => {
      const src = `${imp}export async function f(e) {\n  if (detectComposeHaRoleSwap(e)) return;\n  await ${NAME}(a, b);\n}`;
      expect(findUnguarded('x.js', src)).toEqual([]);
    });

    it('follows an import alias and a seam default to the call', () => {
      const src =
        `import { ${NAME} as real } from './ha.js';\n` +
        `export async function f(e, { reseed = real } = {}) {\n  await reseed(a, b);\n}`;
      expect(findUnguarded('x.js', src)).toEqual(['x.js:3']);
    });

    it('a guard in another function does not count', () => {
      const src = `${imp}function g(e) { assertNoComposeHaRoleSwap(e); }\nexport async function f() {\n  await ${NAME}(a, b);\n}`;
      expect(findUnguarded('x.js', src)).toEqual(['x.js:4']);
    });
  });
});
