/**
 * tests/_shared/ast-walk.ts: the walk and the two node readers the source
 * censuses share. A census is only as good as the nodes its walk reaches, so
 * the walk's reach and its ancestors are pinned here on real parseAst trees.
 */
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import { type AstNode, calleeName, isFunctionNode, walkAst } from '../../_shared/ast-walk.js';

const nodesOf = (code: string) => {
  const seen: { type: string; above: string[] }[] = [];
  walkAst(parseAst(code), (n, ancestors) => {
    seen.push({ type: n.type, above: ancestors.map((a: AstNode) => a.type) });
  });
  return seen;
};

const firstCall = (code: string) => {
  let call: AstNode = null;
  walkAst(parseAst(code), (n) => {
    if (!call && n.type === 'CallExpression') call = n;
  });
  return call;
};

describe('walkAst', () => {
  it('visits every node, parent before child, with the nodes above it outermost first', () => {
    expect(nodesOf('f(a, b);')).toEqual([
      { type: 'Program', above: [] },
      { type: 'ExpressionStatement', above: ['Program'] },
      { type: 'CallExpression', above: ['Program', 'ExpressionStatement'] },
      { type: 'Identifier', above: ['Program', 'ExpressionStatement', 'CallExpression'] },
      { type: 'Identifier', above: ['Program', 'ExpressionStatement', 'CallExpression'] },
      { type: 'Identifier', above: ['Program', 'ExpressionStatement', 'CallExpression'] },
    ]);
  });

  it('reaches into arrays, nested functions and template expressions', () => {
    const types = nodesOf(`const x = [() => { g(\`a \${h()} b\`); }];`).map((n) => n.type);
    expect(types.filter((t) => t === 'CallExpression')).toHaveLength(2);
    expect(types).toContain('ArrowFunctionExpression');
    expect(types).toContain('TemplateLiteral');
  });

  it('starts from any node, with no ancestors above it', () => {
    const call = firstCall('function outer() { return f(1); }');
    const seen: string[][] = [];
    walkAst(call, (_n, ancestors) => seen.push(ancestors.map((a: AstNode) => a.type)));
    expect(seen[0]).toEqual([]);
    expect(seen.slice(1).every((a) => a[0] === 'CallExpression')).toBe(true);
  });

  it('gives each node its own ancestors list', () => {
    const lists: AstNode[][] = [];
    walkAst(parseAst('a; b;'), (_n, ancestors) => lists.push(ancestors));
    expect(new Set(lists).size).toBe(lists.length);
    expect(lists[0]).toEqual([]);
  });

  it('never counts a comment', () => {
    expect(nodesOf('// f(x)\n/* g(y) */').map((n) => n.type)).toEqual(['Program']);
  });
});

describe('isFunctionNode', () => {
  it('is true for a declaration, an expression and an arrow, and false otherwise', () => {
    const fns = nodesOf(
      'function a() {} const b = function () {}; const c = () => 1; class D { m() {} }',
    )
      .map((n) => ({ type: n.type }))
      .filter(isFunctionNode)
      .map((n) => n.type);
    // The class method's value is a FunctionExpression too.
    expect(fns).toEqual([
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'FunctionExpression',
    ]);
    expect(isFunctionNode({ type: 'ClassDeclaration' })).toBe(false);
    expect(isFunctionNode({ type: 'CallExpression' })).toBe(false);
  });
});

describe('calleeName', () => {
  it('names a plain call and the last property of a member call', () => {
    expect(calleeName(firstCall('f(1);'))).toBe('f');
    expect(calleeName(firstCall('a.b.m(1);'))).toBe('m');
    expect(calleeName(firstCall('a?.m(1);'))).toBe('m');
  });

  it('is null for a computed member, a private name and a call of a call', () => {
    expect(calleeName(firstCall('a[m](1);'))).toBeNull();
    expect(calleeName(firstCall('class C { #m() {} n() { this.#m(); } }'))).toBeNull();
    expect(calleeName(firstCall('f()(1);'))).toBeNull();
  });
});
