import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * Census: src/lib/ssh.js's `sshRun` takes an argv ARRAY and throws on anything
 * else ("sshRun requires a non-empty argv array"). A string command compiles,
 * passes every test that mocks ssh.js, and throws in production: fix round 3
 * shipped exactly that in scale.js (the add-on job stop and relaunch), so
 * every compose scale threw before its db restore.
 *
 * Every module that imports `sshRun` from ssh.js is walked, and each call's
 * third argument must not be a string literal, a template, or a string
 * concatenation. (compose/index.js exports its own string-taking `sshRun`;
 * modules importing that one are not walked.)
 */
const SRC = join(import.meta.dirname, '../../../src');

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

function walk(node: Node, fn: (n: Node) => void) {
  fn(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    for (const child of Array.isArray(v) ? v : [v]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, fn);
    }
  }
}

const isStringy = (n: Node): boolean =>
  (n?.type === 'Literal' && typeof n.value === 'string') ||
  n?.type === 'TemplateLiteral' ||
  (n?.type === 'BinaryExpression' &&
    n.operator === '+' &&
    (isStringy(n.left) || isStringy(n.right)));

/**
 * `file:line` of every sshRun(…) whose argv is not visibly an array, in
 * modules that import ssh.js's sshRun. Allowed: an array literal, or a
 * variable (diagnose.js passes its built `argv`). Anything else, a string,
 * a template, a concatenation, or a call returning a command line
 * (addonJobStartCmd), is flagged: a helper that returns a string is how
 * fix round 3 slipped past a literal-only check.
 */
function stringArgvCalls(file: string, text: string): string[] {
  const ast = parseAst(text);
  let localName: string | null = null;
  walk(ast, (n) => {
    if (n.type !== 'ImportDeclaration' || !/(^|\/)ssh\.js$/.test(n.source?.value ?? '')) return;
    for (const sp of n.specifiers ?? []) {
      if (sp.type === 'ImportSpecifier' && (sp.imported?.name ?? sp.imported?.value) === 'sshRun') {
        localName = sp.local.name;
      }
    }
  });
  if (!localName) return [];
  const out: string[] = [];
  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'Identifier') return;
    if (n.callee.name !== localName) return;
    const argv = n.arguments?.[2];
    if (isStringy(argv) || !['ArrayExpression', 'Identifier'].includes(argv?.type)) {
      out.push(`${file}:${text.slice(0, n.start).split('\n').length}`);
    }
  });
  return out;
}

describe('ssh.js sshRun always gets an argv array', () => {
  it('no src/ call passes a string, template or concatenation', () => {
    const offenders = jsFiles(SRC).flatMap((f) =>
      stringArgvCalls(relative(SRC, f), readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('positive control: the walk flags the shapes it must', () => {
    const src =
      "import { sshRun } from './lib/ssh.js';\n" +
      "sshRun(ip, k, 'echo hi');\n" +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'sshRun(ip, k, `cd ${d} && ls`);\n' +
      "sshRun(ip, k, 'a' + b);\n" +
      'sshRun(ip, k, startCmd(p));\n' +
      "sshRun(ip, k, ['sh', '-c', 'echo ok']);\n" +
      'sshRun(ip, k, argv);\n';
    expect(stringArgvCalls('x.js', src)).toEqual(['x.js:2', 'x.js:3', 'x.js:4', 'x.js:5']);
  });

  it('a module importing another sshRun (compose/index.js) is not walked', () => {
    const src = "import { sshRun } from './index.js';\nsshRun(ip, k, 'echo hi');\n";
    expect(stringArgvCalls('y.js', src)).toEqual([]);
  });
});
