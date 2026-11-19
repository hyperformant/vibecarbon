/**
 * The walk the source censuses run over a tree from vite's `parseAst`, which
 * reads `src/` as code rather than text, so a comment never counts as a call.
 * Eight censuses each had their own copy of it. The ones whose walk also
 * carries the parent's key or the enclosing function keep their own.
 */

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
export type AstNode = any;

/**
 * Calls `fn` on `node` and on every node under it, parent before child, with
 * the nodes above it, outermost first. A child is any property value (or
 * array entry) that has a string `type`; `type`, `start` and `end` are
 * passed over.
 */
export function walkAst(
  node: AstNode,
  fn: (n: AstNode, ancestors: AstNode[]) => void,
  ancestors: AstNode[] = [],
): void {
  fn(node, ancestors);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    for (const child of Array.isArray(v) ? v : [v]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') {
        walkAst(child, fn, [...ancestors, node]);
      }
    }
  }
}

/** A function declaration, function expression or arrow function. */
export function isFunctionNode(n: AstNode): boolean {
  return (
    n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression'
  );
}

/**
 * The name a call is made by: `f` for `f()`, `m` for `a.b.m()`. Null for a
 * computed member (`a[m]()`), a private name (`this.#m()`) or anything else.
 */
export function calleeName(call: AstNode): string | null {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property?.type === 'Identifier') {
    return c.property.name;
  }
  return null;
}
