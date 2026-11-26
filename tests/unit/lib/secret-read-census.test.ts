/**
 * Census: a command whose captured output holds a secret says so
 * (`secret: true`), so a failure neither echoes that output under CI or
 * DEBUG nor carries it on the error (runCommandAsync; the behaviour is
 * tests/unit/lib/command-secret-output.test.ts).
 *
 * A review found the compose login read printing a server's whole docker
 * login file into the CI log: the ssh client exited 255 after the remote
 * `cat` had printed it. The family is every read of:
 *
 * - a Secret's data (`kubectl get secret` with `-o json`, `-o yaml` or a
 *   `.data` jsonpath). `-o name` and a `.metadata` jsonpath print no data and
 *   are left out;
 * - a server file over ssh: its `.env` or `app.env`, its docker login file
 *   (/root/.docker/config.json), its kubeconfig (k3s.yaml). Every ssh
 *   command that names one of them is held to the rule, a write as much as a
 *   read: the census cannot tell them apart, and a write marked secret only
 *   loses a debug echo. The kubeconfig and the .env pull reach this machine by
 *   scp, file to file, with nothing on stdout, so scp is not a runner here.
 *
 * Read with vite's parseAst over every `.js` file under src/, so a comment
 * never counts. Each rule slices the call that runs the command, not the
 * file: a guard over a whole file passes while another call in it leaks.
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

type Parsed = { path: string; text: string; ast: Node };
const FILES: Parsed[] = sourceFiles(SRC, { exts: ['.js'] }).map((abs) => {
  const text = readFileSync(abs, 'utf-8');
  return { path: relative(SRC, abs), text, ast: parseAst(text) };
});

const lineOf = (file: Parsed, node: Node) => file.text.slice(0, node.start).split('\n').length;

/** Every node of a tree with the nodes above it, so an upward search can start anywhere. */
function withAncestors(ast: Node): Map<Node, Node[]> {
  const out = new Map<Node, Node[]>();
  walkAst(ast, (n, ancestors) => out.set(n, ancestors));
  return out;
}

/** Whether an options object says `secret: true` in so many words. */
function saysSecret(options: Node): boolean {
  return options.properties.some(
    (p: Node) =>
      p.type === 'Property' &&
      !p.computed &&
      (p.key?.name ?? p.key?.value) === 'secret' &&
      p.value?.type === 'Literal' &&
      p.value.value === true,
  );
}

/** The name of a function node, from its declaration or the binding it is assigned to. */
function nameOfFn(fn: Node, parent: Node): string | null {
  if (fn.id?.name) return fn.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key?.name) {
    return parent.key.name;
  }
  return null;
}

/** The nearest named function around a node, as `file:name`. */
function enclosingKey(path: string, ancestors: Node[]): string {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isFunctionNode(ancestors[i])) continue;
    const name = nameOfFn(ancestors[i], ancestors[i - 1]);
    if (name) return `${path}:${name}`;
  }
  return `${path}:<module>`;
}

type Run = { key: string; line: number; secret: boolean };

/** `Object.freeze(...)`: a wrapper, not a runner. */
const isFreeze = (call: Node) =>
  call.callee?.type === 'MemberExpression' &&
  call.callee.object?.name === 'Object' &&
  call.callee.property?.name === 'freeze';

/** Where an upward search stops: past it, the command is no longer an argument. */
const BOUNDARIES = new Set([
  'VariableDeclarator',
  'ReturnStatement',
  'ExpressionStatement',
  'AssignmentExpression',
  'Property',
]);

/**
 * The calls that run a command built at `node`: up from it to the first call
 * that takes an options object after the argument holding it (through
 * builders such as kubectlArgv, which take none). When none does, the
 * outermost call passed is the runner, and it says nothing of a secret. An
 * array bound to a name (`const ARGV = Object.freeze([...])`) is followed to
 * each use of the name; one a function returns, to each call of the function.
 * Null when the runner cannot be found: a shape this census does not know.
 */
function runsOf(file: Parsed, index: Map<Node, Node[]>, node: Node, depth = 0): Run[] | null {
  if (depth > 3) return null;
  const ancestors = index.get(node) ?? [];
  let child = node;
  let outer = -1;
  let returned = false;
  const follow = (refs: Node[]) => {
    if (refs.length === 0) return null;
    const runs = refs.map((r) => runsOf(file, index, r, depth + 1));
    return runs.some((r) => r === null) ? null : (runs.flat() as Run[]);
  };
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const up = ancestors[i];
    if (up.type === 'CallExpression') {
      const at = up.arguments.indexOf(child);
      const options =
        at >= 0
          ? up.arguments.slice(at + 1).find((a: Node) => a.type === 'ObjectExpression')
          : null;
      if (options) {
        const key = enclosingKey(file.path, ancestors.slice(0, i));
        return [{ key, line: lineOf(file, up), secret: saysSecret(options) }];
      }
      if (!isFreeze(up)) outer = i;
      child = up;
      continue;
    }
    if (outer >= 0 && (BOUNDARIES.has(up.type) || isFunctionNode(up))) {
      const call = ancestors[outer];
      return [
        {
          key: enclosingKey(file.path, ancestors.slice(0, outer)),
          line: lineOf(file, call),
          secret: false,
        },
      ];
    }
    if (up.type === 'VariableDeclarator') {
      if (up.id?.type !== 'Identifier' || child !== up.init) return null;
      const name = up.id.name;
      const uses: Node[] = [];
      walkAst(file.ast, (n, a) => {
        if (n.type === 'Identifier' && n.name === name && a.at(-1) !== up) uses.push(n);
      });
      return follow(uses);
    }
    if (up.type === 'ReturnStatement') returned = true;
    if (isFunctionNode(up)) {
      const name = nameOfFn(up, ancestors[i - 1]);
      if (!name || !(returned || child === up.body)) return null;
      const calls: Node[] = [];
      walkAst(file.ast, (n) => {
        if (n.type === 'CallExpression' && calleeName(n) === name) calls.push(n);
      });
      return follow(calls);
    }
    if (BOUNDARIES.has(up.type)) return null;
    child = up;
  }
  return null;
}

const str = (n: Node): string | null =>
  n?.type === 'Literal' && typeof n.value === 'string'
    ? n.value
    : n?.type === 'TemplateLiteral'
      ? n.quasis.map((q: Node) => q.value?.cooked ?? '').join('<expr>')
      : null;

/** Whether a `get secret` argv prints no data: `-o name`, or a jsonpath of `.metadata` alone. */
function printsNoData(elements: Array<string | null>): boolean {
  const output = elements
    .map((e, i) => (e === '-o' ? elements[i + 1] : e?.startsWith('-o=') ? e.slice(3) : null))
    .find((o) => o != null);
  if (output === 'name') return true;
  if (output?.startsWith('jsonpath=')) {
    const paths = output.match(/\{[^}]*\}/g) ?? [];
    return paths.length > 0 && paths.every((p) => p.startsWith('{.metadata.'));
  }
  return false;
}

describe("every read of a Secret's data is a secret read", () => {
  const reads: Array<{ at: string; runs: Run[] | null }> = [];
  for (const file of FILES) {
    const index = withAncestors(file.ast);
    walkAst(file.ast, (n) => {
      if (n.type !== 'ArrayExpression') return;
      const els = n.elements.map((e: Node) => str(e));
      const getSecret = els.some(
        (e: string | null, i: number) =>
          e === 'get' && (els[i + 1] === 'secret' || els[i + 1] === 'secrets'),
      );
      if (!getSecret || printsNoData(els)) return;
      reads.push({ at: `${file.path}:${lineOf(file, n)}`, runs: runsOf(file, index, n) });
    });
  }

  it('finds the reads it guards', () => {
    // The ones known when this census was written; a new one only adds.
    const where = reads.flatMap((r) => r.runs ?? []).map((r) => r.key);
    for (const key of [
      'lib/deploy/k8s/ghcr-pull-secret.js:readGhcrPullSecret',
      'lib/deploy/k8s/k3s.js:readSecretFingerprints',
      'lib/deploy/k8s/k3s.js:readRestoreMarker',
      'lib/deploy/replication.js:getReplPasswordFromSecret',
      'scale.js:readSecretKey',
      'lib/deploy/k8s/tls-restore.js:readLiveSecret',
      'lib/deploy/k8s/tls-restore.js:liveK8sTlsSecretSerial',
    ]) {
      expect(where, key).toContain(key);
    }
  });

  it('each one runs with secret: true', () => {
    const unknown = reads.filter((r) => r.runs === null).map((r) => r.at);
    expect(unknown, 'a get secret whose runner this census cannot find').toEqual([]);
    const open = reads
      .flatMap((r) => r.runs ?? [])
      .filter((run) => !run.secret)
      .map((run) => `${run.key} (line ${run.line})`);
    expect(open).toEqual([]);
  });
});

/** A server file whose content is a secret, as an ssh command names it. */
const SECRET_FILE = /(^|[\s/'"=])(app)?\.env(?![.\w-])|\.docker\/config\.json|k3s\.yaml/;
/** The ssh runners: each takes the command, then its options. */
const SSH_RUNNERS = new Set(['sshRun', 'sshRunAsync', 'sshKubectl', 'sshRunScript']);
/**
 * Calls held to the rule by name but exempt, each with its reason.
 * sshKubectl points kubectl at the kubeconfig (KUBECONFIG=...k3s.yaml) and
 * prints what kubectl prints, which the Secret rule above holds its callers to.
 */
const EXEMPT = new Set(['lib/ssh.js:sshKubectl']);

/**
 * The strings a call's arguments hold, following a name to its declaration,
 * in the module or in the function the call sits in, a few hops deep: a
 * script is often built a line above the call, or by a helper with the file
 * as its default.
 */
function textsOf(
  file: Parsed,
  scope: Node | null,
  node: Node,
  depth: number,
  seen = new Set<Node>(),
): string[] {
  const decls = new Map<string, Node[]>();
  const add = (name: string, n: Node) => decls.set(name, [...(decls.get(name) ?? []), n]);
  for (const st of file.ast.body) {
    const d = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
    if (d?.type === 'FunctionDeclaration' && d.id) add(d.id.name, d);
    if (d?.type === 'VariableDeclaration') {
      for (const v of d.declarations)
        if (v.id?.type === 'Identifier' && v.init) add(v.id.name, v.init);
    }
  }
  if (scope) {
    walkAst(scope, (n) => {
      if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init)
        add(n.id.name, n.init);
    });
  }
  const out: string[] = [];
  const visit = (root: Node, left: number) => {
    if (seen.has(root)) return;
    seen.add(root);
    walkAst(root, (m) => {
      if (m.type === 'Literal' && typeof m.value === 'string') out.push(m.value);
      if (m.type === 'TemplateElement') out.push(m.value?.cooked ?? '');
      if (left > 0 && m.type === 'Identifier')
        for (const d of decls.get(m.name) ?? []) visit(d, left - 1);
    });
  };
  visit(node, depth);
  return out;
}

describe('every ssh command on a server .env, docker login file or kubeconfig is a secret read', () => {
  const calls: Array<{ key: string; line: number; secret: boolean | null; names: string }> = [];
  for (const file of FILES) {
    walkAst(file.ast, (n, ancestors) => {
      if (n.type !== 'CallExpression') return;
      const name = calleeName(n);
      // The injected ssh runner of readOldAppEnv (`run`, sshRun by default)
      // is held too: its name alone says nothing, so its argv decides.
      if (!SSH_RUNNERS.has(name ?? '') && name !== 'run') return;
      const fn = [...ancestors].reverse().find((a) => isFunctionNode(a)) ?? null;
      const named = n.arguments
        .flatMap((a: Node) => textsOf(file, fn, a, 3))
        .find((t: string) => SECRET_FILE.test(t));
      if (!named) return;
      const key = enclosingKey(file.path, ancestors);
      if (EXEMPT.has(key)) return;
      const options = n.arguments.slice(1).find((a: Node) => a.type === 'ObjectExpression');
      calls.push({
        key,
        line: lineOf(file, n),
        secret: options ? saysSecret(options) : null,
        names: named.replace(/\s+/g, ' ').slice(0, 60),
      });
    });
  }

  it('finds the commands it guards', () => {
    const keys = calls.map((c) => c.key);
    for (const key of [
      'lib/deploy/compose/ghcr-login.js:readGhcrLoginOnServer',
      'lib/deploy/compose/ghcr-login.js:removeGhcrLogin',
      'lib/deploy/compose/index.js:dockerLoginOnServer',
      'scale.js:readOldAppEnv',
      'scale.js:readOldServerEnv',
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it('each one runs with secret: true', () => {
    const open = calls
      .filter((c) => c.secret !== true)
      .map((c) => `${c.key} (line ${c.line}, names ${c.names})`);
    expect(open).toEqual([]);
  });
});
