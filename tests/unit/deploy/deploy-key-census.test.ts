/**
 * Census: no deploy makes a new deploy key for servers that already exist
 * (PR 2 final review C1(a), src/lib/deploy/deploy-key.js).
 *
 * A deploy key is made in exactly two places, generateSSHKeyPair
 * (deploy/utils.js) and ensureSshKey (deploy/k8s/k3s.js): the only
 * `ssh-keygen` in src/ sits in their bodies. Every call of either one runs
 * requireDeployKey earlier in the same function, so a new caller can't make a
 * key for an environment whose servers trust another one.
 * deploy-key-refusal.test.ts runs each of today's callers against a real
 * generator; this census holds the line for the next one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE,
  enclosingFunctionName,
  findCalls,
  functionRanges,
  lex,
  matchBracket,
  STRING,
} from '../helpers/js-call-scan.js';

const ROOT = join(__dirname, '../../..');
const GENERATORS = ['generateSSHKeyPair', 'ensureSshKey'] as const;
const GUARD = 'requireDeployKey';

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

/** Generator calls with no requireDeployKey before them in their own function. */
function unguardedCalls(text: string): string[] {
  const calls = findCalls(text, [...GENERATORS, GUARD]);
  return calls
    .filter((call) => call.name !== GUARD)
    .filter(
      (call) =>
        !calls.some((guard) => guard.name === GUARD && guard.fn === call.fn && guard.at < call.at),
    )
    .map((call) => `${call.fn}: ${call.name}( at line ${call.line}`);
}

/** The functions whose bodies hold an `ssh-keygen` string. */
function sshKeygenHomes(text: string): string[] {
  const { mask } = lex(text);
  const ranges = functionRanges(text, mask);
  const homes: string[] = [];
  for (const m of text.matchAll(/ssh-keygen/g)) {
    const at = m.index ?? 0;
    if (mask[at] === STRING) homes.push(enclosingFunctionName(ranges, at));
  }
  return homes;
}

/** The keys an object literal opened at `opener` sets at its top level (shorthand or `key:`). */
function topLevelKeys(text: string, opener: string): string[] {
  const { mask } = lex(text);
  const open = text.indexOf(opener) + opener.length - 1;
  expect(open, `${opener} not found`).toBeGreaterThan(opener.length - 2);
  const close = matchBracket(text, mask, open);
  const keys: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i <= close; i++) {
    if (mask[i] !== CODE) continue;
    const c = text[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c) && i !== close) depth -= 1;
    else if ((c === ',' && depth === 0) || i === close) {
      const entry = [...text.slice(start, i)]
        .filter((_, k) => mask[start + k] === CODE)
        .join('')
        .trim();
      const key = /^(?:\.\.\.)?([\w$]+)/.exec(entry)?.[1];
      if (key) keys.push(key);
      start = i + 1;
    }
  }
  return keys;
}

const SOURCES = jsFiles(join(ROOT, 'src')).map((path) => ({
  rel: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

describe('deploy key census', () => {
  it('a key is made only by the two generators: every ssh-keygen in src/ is in their bodies', () => {
    const homes = SOURCES.flatMap(({ rel, text }) =>
      sshKeygenHomes(text).map((fn) => `${rel}: ${fn}`),
    );
    expect(homes.sort()).toEqual([
      'src/lib/deploy/k8s/k3s.js: ensureSshKey',
      'src/lib/deploy/utils.js: generateSSHKeyPair',
    ]);
  });

  it('every generator call runs requireDeployKey first, in the same function', () => {
    const unguarded = SOURCES.flatMap(({ rel, text }) =>
      unguardedCalls(text).map((site) => `${rel}: ${site}`),
    );
    expect(unguarded).toEqual([]);
  });

  it("finds today's callers, so the check above can't pass on nothing", () => {
    const callers = SOURCES.flatMap(({ rel, text }) =>
      findCalls(text, [...GENERATORS])
        .filter((call) => call.name !== GUARD)
        .map((call) => `${rel}: ${call.fn}`),
    );
    expect(callers.sort()).toEqual([
      'src/lib/deploy/effects/compose-ha.js: haProvisionServers',
      'src/lib/deploy/effects/index.js: provisionServer',
      'src/lib/deploy/effects/k8s-ha.js: haK8sGenerateSshKey',
      'src/lib/deploy/k8s/k3s.js: deployK3sSteps',
    ]);
  });

  it("the k8s modes' own checks see the record: deploymentConfig carries envConfig to deployK3s and the k8s-ha key step", () => {
    const text = readFileSync(join(ROOT, 'src/lib/deploy/orchestrator.js'), 'utf8');
    expect(topLevelKeys(text, 'const deploymentConfig = {')).toContain('envConfig');
    // Both k8s tiers hand the effects that object as their options.
    expect(text).toContain('const k8sCtx = { options: { ...deploymentConfig,');
    expect(text).toContain('const k8sHaCtx = { options: deploymentConfig,');
  });

  it('bites: a caller with no guard, or the guard after the call, is reported', () => {
    const noGuard = `async function provision(ctx) {\n  generateSSHKeyPair(ctx.key);\n}\n`;
    const late = `async function provision(ctx) {\n  const k = await ensureSshKey(d, e);\n  requireDeployKey(ctx);\n}\n`;
    const otherFn = `function check(ctx) {\n  requireDeployKey(ctx);\n}\nfunction provision(ctx) {\n  generateSSHKeyPair(ctx.key);\n}\n`;
    const guarded = `async function provision(ctx) {\n  requireDeployKey(ctx);\n  generateSSHKeyPair(ctx.key);\n}\n`;
    expect(unguardedCalls(noGuard)).toEqual(['provision: generateSSHKeyPair( at line 2']);
    expect(unguardedCalls(late)).toEqual(['provision: ensureSshKey( at line 2']);
    expect(unguardedCalls(otherFn)).toEqual(['provision: generateSSHKeyPair( at line 5']);
    expect(unguardedCalls(guarded)).toEqual([]);
    expect(sshKeygenHomes(`function mint(p) {\n  run(['ssh-keygen', '-f', p]);\n}\n`)).toEqual([
      'mint',
    ]);
  });
});
