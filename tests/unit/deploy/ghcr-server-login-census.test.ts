/**
 * Census: no value `gh auth token` prints can reach a server.
 *
 * Three paths once logged every compose server into ghcr.io with the
 * operator's full gh token (repo, workflow, read:org): a compose push deploy
 * (ensureCIImageReady's ghcrPullCreds, then the ghcrLogin effect), the
 * compose-ha login fan-out, and `vibecarbon scale` (getGHCRCredentials).
 * docker keeps a login as base64 in /root/.docker/config.json, so root on the
 * server was every repo the operator can push to. A server now logs in to
 * ghcr.io only with the read:packages pull token, through one function,
 * ensureGhcrLoginOn (src/lib/deploy/compose/ghcr-login.js).
 *
 * Read with vite's parseAst over every `.js` file under src/, so a comment
 * never counts. Each rule slices the function a call sits in, not the file:
 * a guard over a whole file passes while the file still holds the call.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  calleeName,
  isFunctionNode,
  type AstNode as Node,
  walkAst,
} from '../../_shared/ast-walk.js';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';

const SRC = join(REPO_ROOT, 'src');
const ENSURE = 'lib/deploy/compose/ghcr-login.js:ensureGhcrLoginOn';
const MANIFEST_WAIT = 'lib/ci-setup.js:waitForGhcrManifest';
const GH_TOKEN_READER = 'lib/ci-setup.js:getGHCRToken';

type Parsed = { path: string; ast: Node };
const FILES: Parsed[] = sourceFiles(SRC, { exts: ['.js'] }).map((abs) => ({
  path: relative(SRC, abs),
  ast: parseAst(readFileSync(abs, 'utf-8')),
}));

function nameOfFn(fnNode: Node, parent: Node): string | null {
  if (fnNode.id?.name) return fnNode.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key?.name) {
    return parent.key.name;
  }
  return null;
}

/** The nearest named function around a node, as `file:name`, and that function's node. */
function enclosing(path: string, ancestors: Node[]): { key: string; fn: Node | null } {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isFunctionNode(ancestors[i])) continue;
    const name = nameOfFn(ancestors[i], ancestors[i - 1]);
    if (name) return { key: `${path}:${name}`, fn: ancestors[i] };
  }
  return { key: `${path}:<module>`, fn: null };
}

type Call = { key: string; fn: Node | null; node: Node };
function callsOf(callee: string): Call[] {
  const out: Call[] = [];
  for (const { path, ast } of FILES) {
    walkAst(ast, (n, ancestors) => {
      if (n.type === 'CallExpression' && calleeName(n) === callee) {
        out.push({ ...enclosing(path, ancestors), node: n });
      }
    });
  }
  return out;
}

/** Whether a string literal (or a template part) spelling exactly `value` sits under `node`. */
function holdsString(node: Node, value: string): boolean {
  let found = false;
  walkAst(node, (n) => {
    if (n.type === 'Literal' && n.value === value) found = true;
    if (n.type === 'TemplateElement' && n.value?.cooked === value) found = true;
  });
  return found;
}

/**
 * A rename on import hides every call from the name match, so one is a
 * finding: `import { x as y }`, and the lazy `const { x: y } = await import()`.
 */
function aliasesOf(name: string): string[] {
  const out: string[] = [];
  for (const { path, ast } of FILES) {
    walkAst(ast, (n) => {
      if (n.type === 'ImportSpecifier') {
        const imported = n.imported?.name ?? n.imported?.value;
        if (imported === name && n.local?.name !== name) out.push(`${path}: as ${n.local?.name}`);
        return;
      }
      if (n.type !== 'VariableDeclarator' || n.id?.type !== 'ObjectPattern') return;
      const init = n.init?.type === 'AwaitExpression' ? n.init.argument : n.init;
      if (init?.type !== 'ImportExpression') return;
      for (const prop of n.id.properties) {
        if (prop.type !== 'Property' || prop.computed) continue;
        const target = prop.value?.type === 'AssignmentPattern' ? prop.value.left : prop.value;
        if ((prop.key?.name ?? prop.key?.value) === name && target?.name !== name) {
          out.push(`${path}: as ${target?.name}`);
        }
      }
    });
  }
  return out;
}

describe('a server logs in to ghcr.io only through ensureGhcrLoginOn', () => {
  const logins = callsOf('dockerLoginOnServer');

  it('the only call of dockerLoginOnServer whose argument names ghcr.io is inside ensureGhcrLoginOn', () => {
    const ghcr = logins.filter((c) =>
      c.node.arguments.some((a: Node) => holdsString(a, 'ghcr.io')),
    );
    expect(ghcr.map((c) => c.key)).toEqual([ENSURE]);
  });

  it('every other call logs in to Docker Hub, with the operator Docker Hub credentials', () => {
    const others = logins.filter((c) => c.key !== ENSURE);
    expect(others.length).toBeGreaterThan(0);
    for (const call of others) {
      const creds = call.node.arguments[2];
      expect(
        creds?.type === 'Identifier' && creds.name,
        `${call.key} logs a server in with something other than dockerHubCreds`,
      ).toBe('dockerHubCreds');
    }
  });

  it('no other function that logs a server in holds a ghcr.io registry name', () => {
    // A `{ registry: 'ghcr.io' }` built a line above the call and passed by
    // name (the old compose-ha fan-out) is caught here, in the function's own
    // slice.
    const holders = logins
      .filter((c) => c.key !== ENSURE && c.fn && holdsString(c.fn, 'ghcr.io'))
      .map((c) => c.key);
    expect(holders).toEqual([]);
  });

  it('dockerLoginOnServer is never imported under another name', () => {
    expect(aliasesOf('dockerLoginOnServer')).toEqual([]);
  });
});

describe('the gh token stays on this machine', () => {
  it('getGHCRToken( is called only inside waitForGhcrManifest', () => {
    // The tag check (ghcrTagExists) asks through `gh api`, which holds the
    // token itself, so it is not a caller.
    expect([...new Set(callsOf('getGHCRToken').map((c) => c.key))]).toEqual([MANIFEST_WAIT]);
    expect(aliasesOf('getGHCRToken')).toEqual([]);
  });

  it('waitForGhcrManifest returns no token: every return is true or false', () => {
    const [{ fn }] = callsOf('getGHCRToken');
    const returns: Node[] = [];
    walkAst(fn.body, (n, ancestors) => {
      // A return inside a nested function is that function's, not this one's.
      if (n.type === 'ReturnStatement' && !ancestors.some((a) => isFunctionNode(a))) {
        returns.push(n);
      }
    });
    expect(returns.length).toBeGreaterThan(0);
    for (const r of returns) {
      expect(r.argument?.type === 'Literal' && typeof r.argument.value).toBe('boolean');
    }
  });

  it('getGHCRToken is not exported, so nothing outside ci-setup.js can call it', () => {
    const ciSetup = FILES.find((f) => f.path === 'lib/ci-setup.js');
    let exported = false;
    walkAst(ciSetup?.ast, (n) => {
      if (n.type === 'ExportNamedDeclaration') {
        if (n.declaration?.id?.name === 'getGHCRToken') exported = true;
        for (const s of n.specifiers ?? []) {
          if ((s.local?.name ?? s.local?.value) === 'getGHCRToken') exported = true;
        }
      }
    });
    expect(exported).toBe(false);
  });

  it('`gh auth token` is run only inside getGHCRToken', () => {
    const runs: string[] = [];
    for (const { path, ast } of FILES) {
      walkAst(ast, (n, ancestors) => {
        const argv =
          n.type === 'ArrayExpression' &&
          n.elements.slice(0, 3).map((e: Node) => (e?.type === 'Literal' ? e.value : null));
        const spelled =
          (Array.isArray(argv) && argv.join(' ') === 'gh auth token') ||
          (n.type === 'Literal' && typeof n.value === 'string' && /^gh auth token\b/.test(n.value));
        if (spelled) runs.push(enclosing(path, ancestors).key);
      });
    }
    expect(runs).toEqual([GH_TOKEN_READER]);
  });

  it('no src file calls getGHCRCredentials', () => {
    const named: string[] = [];
    for (const { path, ast } of FILES) {
      walkAst(ast, (n) => {
        if (n.type === 'Identifier' && n.name === 'getGHCRCredentials') named.push(path);
      });
    }
    expect(named).toEqual([]);
  });
});
