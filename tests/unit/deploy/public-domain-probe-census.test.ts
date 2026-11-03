/**
 * Census: every operator-side request to the app's public domain resolves
 * through public DNS, via src/lib/deploy/public-domain-probe.js.
 *
 * Why (DO k8s-ha e2e, 2026-11-02): deploy's health and TLS probes passed, and
 * seconds later `vibecarbon status -json` failed `getaddrinfo ENOTFOUND
 * d4.do.appcarbon.dev`. The record was live on the authoritative nameservers
 * and on 8.8.8.8; the operator's system resolver still held the NXDOMAIN it
 * cached during the previous run's destroy (SOA minimum 1800s). Deploy was
 * immune only because its probe pinned its lookup to public DNS; status's
 * readiness and TLS probes used the system resolver. One approach everywhere
 * is the fix, and this census keeps it that way.
 *
 * Walked with vite's parseAst over every `.js` file under `src/`, so comments
 * never count. Four rules:
 *
 * 1. Raw socket and HTTP openers (`tls.connect`, `net.connect`,
 *    `https.request`/`get`, `http.request`/`get`, undici's `fetch`, `request`,
 *    `Agent`, `Client`, `Pool`) live only in the helper, plus the one global
 *    dispatcher in fetch-retry.js (provider APIs, never the app's domain).
 *    Import bindings are resolved, so `import { connect } from 'node:tls'`,
 *    `import * as h from 'node:https'` and `const { Agent: A } = await
 *    import('undici')` count the same as the dotted spelling.
 * 2. Every domain URL site (below) is printed (`link(...)`), a curl already
 *    pinned with `--resolve` (the server-side curls of failover and
 *    compose-ha), a value written into config (the NOT_A_PROBE table, each
 *    with its reason), or sits in a function that uses the helper. This rule
 *    forces a decision on every new domain URL.
 * 3. A function holding a domain URL never touches the bare global `fetch` or
 *    `fetchWithRetry`: both resolve through the system resolver. This is the
 *    exact shape status had (`deps.fetch || fetch`), where the URL was handed
 *    to a wrapper and the wrapper did the fetch.
 * 4. Per call: every request call (a callee named like `fetch`, a rule 1
 *    opener, or a curl argv) that is given a domain URL, directly or through
 *    a local `const`, is the helper itself or a curl pinned with `--resolve`
 *    (a literal, or a spread of `publicCurlResolveArgs`). One pinned request
 *    in a function never excuses a raw one beside it.
 *
 * A domain URL is a template literal `http(s)://${<expr naming a domain>}`, a
 * concatenation `'http(s)://' + <expr naming a domain>`, a `new URL(...)` of
 * either, or a local `const`/`let` bound to any of these in the same function.
 *
 * Blind spots, by design (each would need data-flow analysis): a host held
 * in a variable not named like `domain` (`host`, `apex`); a URL passed
 * through a function parameter into a wrapper that does the request, which
 * rule 3 catches only when the system fetch is referenced in the function
 * that builds the URL; and URLs read from config at runtime.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = join(REPO, 'src');

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

const HELPER_FILE = 'lib/deploy/public-domain-probe.js';
/** The helper's exports that reach the domain through public DNS. */
const HELPER_NAMES = new Set([
  'fetchPublicDomain',
  'connectPublicTls',
  'publicProbeConnect',
  'publicCurlResolveArgs',
]);
/** Bare names that resolve through the system resolver. */
const SYSTEM_FETCHES = new Set(['fetch', 'fetchWithRetry']);

/** file -> raw openers it may call, and why. */
const RAW_OPENERS_ALLOWED: Record<string, { calls: string[]; why: string }> = {
  [HELPER_FILE]: {
    calls: ['undici.Agent', 'undici.fetch', 'tls.connect'],
    why: 'the helper itself',
  },
  'lib/fetch-retry.js': {
    calls: ['undici.Agent'],
    why: 'the process-wide keep-alive dispatcher for provider and DNS APIs, never the app domain',
  },
};

/** `file:fn` holding a domain URL that is not a request, and why. */
const NOT_A_PROBE: Record<string, string> = {
  'configure.js:oauthCallbackUrl':
    'the OAuth callback URI shown to the operator to paste into a provider console',
  'lib/deploy/bundle.js:renderBundle':
    'SITE_URL written into the app env; the app serves it, the CLI never requests it',
  'lib/deploy/compose/build-args.js:collectComposeBuildArgs':
    'VITE_PUBLIC_URL baked into the client build',
  'lib/deploy/k8s/gitops-deploy.js:deployK8sGitOps': 'SITE_URL in the GitOps ConfigMap values',
  'lib/deploy/k8s/k3s.js:buildK3sBuildInputs': 'siteUrl handed to the image build',
  'lib/deploy/k8s/k3s.js:applyObservabilitySecrets': 'SITE_URL in the grafana-config ConfigMap',
  'lib/deploy/k8s/k3s.js:applyK3sManifests':
    'SITE_URL patched into the vibecarbon-config ConfigMap',
  'lib/deploy/orchestrator.js:envCorsOrigins':
    'the bucket CORS origin the browser sends, a header value, not a request',
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

/** The nearest NAMED enclosing function (or the module), and its node. */
function enclosing(ancestors: Node[]): { name: string; node: Node | null } {
  let sawAnonymous = false;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isFn(ancestors[i])) continue;
    const nm = nameOfFn(ancestors[i], ancestors[i - 1]);
    if (nm) return { name: nm, node: ancestors[i] };
    sawAnonymous = true;
  }
  return { name: sawAnonymous ? '<anonymous>' : '<module>', node: null };
}

const OPENERS = new Set([
  'tls.connect',
  'net.connect',
  'net.createConnection',
  'https.request',
  'https.get',
  'http.request',
  'http.get',
  'undici.fetch',
  'undici.request',
  'undici.Agent',
  'undici.Client',
  'undici.Pool',
]);
const NET_MODULES = new Set(['tls', 'net', 'https', 'http', 'undici']);
const modName = (v: unknown) =>
  typeof v === 'string' ? v.replace(/^node:/, '') : (null as string | null);

/**
 * Import bindings to the network modules: local name -> `module` for a
 * namespace/default import, `module.export` for a named one.
 */
function importBindings(ast: Node): Map<string, string> {
  const out = new Map<string, string>();
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration') {
      const mod = modName(n.source.value);
      if (!mod || !NET_MODULES.has(mod)) return;
      for (const sp of n.specifiers) {
        if (sp.type === 'ImportSpecifier') {
          out.set(sp.local.name, `${mod}.${sp.imported.name ?? sp.imported.value}`);
        } else {
          out.set(sp.local.name, mod);
        }
      }
      return;
    }
    // `const x = await import('undici')` / `const { Agent: A } = await import('undici')`
    if (n.type !== 'VariableDeclarator') return;
    const init = n.init?.type === 'AwaitExpression' ? n.init.argument : n.init;
    if (init?.type !== 'ImportExpression') return;
    const mod = modName(init.source?.value);
    if (!mod || !NET_MODULES.has(mod)) return;
    if (n.id.type === 'Identifier') out.set(n.id.name, mod);
    if (n.id.type === 'ObjectPattern') {
      for (const prop of n.id.properties) {
        if (prop.type !== 'Property' || prop.computed) continue;
        const exported = prop.key?.name ?? prop.key?.value;
        if (prop.value?.type === 'Identifier') out.set(prop.value.name, `${mod}.${exported}`);
      }
    }
  });
  return out;
}

/** The opener a call or `new` resolves to through the file's imports, if any. */
function rawOpener(n: Node, bindings: Map<string, string>): string | null {
  if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return null;
  const c = n.callee;
  let resolved: string | null = null;
  if (c.type === 'Identifier') {
    resolved = bindings.get(c.name) ?? null;
    // An unresolved `new Agent(` (a global, a re-export) is still an Agent.
    if (!resolved && n.type === 'NewExpression' && c.name === 'Agent') resolved = 'undici.Agent';
  } else if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier') {
    const base =
      bindings.get(c.object.name) ?? (NET_MODULES.has(c.object.name) ? c.object.name : null);
    if (base && !base.includes('.')) resolved = `${base}.${c.property.name}`;
    if (!resolved && n.type === 'NewExpression' && c.property.name === 'Agent') {
      resolved = 'undici.Agent';
    }
  }
  return resolved && OPENERS.has(resolved) ? resolved : null;
}

const SCHEME_END = /https?:\/\/$/;
const namesDomain = (n: Node, text: string) => /domain/i.test(text.slice(n.start, n.end));

/** A domain URL literal: a template or a concatenation (not a binding). */
function isDomainUrlLiteral(n: Node, text: string): boolean {
  if (n.type === 'TemplateLiteral') {
    return n.expressions.some((expr: Node, i: number) => {
      const before = n.quasis[i].value.cooked ?? n.quasis[i].value.raw;
      return SCHEME_END.test(before) && namesDomain(expr, text);
    });
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    // Leftmost string operand ends in the scheme; some operand names a domain.
    let left = n.left;
    while (left.type === 'BinaryExpression' && left.operator === '+') left = left.left;
    const head =
      left.type === 'Literal' && typeof left.value === 'string'
        ? left.value
        : left.type === 'TemplateLiteral' && left.expressions.length === 0
          ? left.quasis[0].value.cooked
          : null;
    return !!head && SCHEME_END.test(head) && namesDomain(n, text);
  }
  return false;
}

/** A domain URL value: a literal, a `new URL(...)` of one, or a bound name. */
function isDomainUrlValue(n: Node, text: string, bound: Set<string>): boolean {
  if (!n) return false;
  if (isDomainUrlLiteral(n, text)) return true;
  if (n.type === 'Identifier') return bound.has(n.name);
  if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'URL') {
    return n.arguments.some((a: Node) => isDomainUrlValue(a, text, bound));
  }
  if (n.type === 'AwaitExpression') return isDomainUrlValue(n.argument, text, bound);
  return false;
}

/** Identifiers a function's body references by name (callee, value, or member property). */
function referencedNames(fnNode: Node | null, root: Node): Set<string> {
  const out = new Set<string>();
  walk(fnNode ?? root, (n, anc) => {
    if (n.type !== 'Identifier') return;
    const parent = anc[anc.length - 1];
    // `deps.fetch` is a property, not the global; `x.fetchPublicDomain(` still counts.
    if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) {
      if (HELPER_NAMES.has(n.name)) out.add(n.name);
      return;
    }
    if (parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) {
      return;
    }
    out.add(n.name);
  });
  return out;
}

function calleeName(call: Node): string | null {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed) return c.property?.name ?? null;
  return null;
}

/** A curl argv: an array whose first element is the literal 'curl', or a call given 'curl'. */
function curlArgv(call: Node): Node | null {
  const args = call.arguments;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (
      a.type === 'ArrayExpression' &&
      a.elements[0]?.type === 'Literal' &&
      a.elements[0].value === 'curl'
    ) {
      return a;
    }
    if (a.type === 'Literal' && a.value === 'curl' && args[i + 1]?.type === 'ArrayExpression') {
      return args[i + 1];
    }
  }
  return null;
}

/** The argv carries `--resolve`, as a literal or a spread of publicCurlResolveArgs. */
function curlPinned(argv: Node, pinNames: Set<string>): boolean {
  return argv.elements.some((e: Node) => {
    if (e?.type === 'Literal' && e.value === '--resolve') return true;
    if (e?.type !== 'SpreadElement') return false;
    const arg = e.argument.type === 'AwaitExpression' ? e.argument.argument : e.argument;
    if (arg.type === 'Identifier') return pinNames.has(arg.name);
    return arg.type === 'CallExpression' && calleeName(arg) === 'publicCurlResolveArgs';
  });
}

interface Finding {
  rule: 1 | 2 | 3 | 4;
  where: string;
  detail: string;
}

/** Run the four rules over one source file (the bite test calls it on synthetic sources). */
function scan(path: string, text: string): { findings: Finding[]; exemptKeys: string[] } {
  const ast = parseAst(text);
  const findings: Finding[] = [];
  const exemptKeys: string[] = [];
  const allowed = RAW_OPENERS_ALLOWED[path]?.calls ?? [];
  const bindings = importBindings(ast);

  // Per function: names bound to a domain URL, and names bound to a curl pin.
  const boundByFn = new Map<Node | null, Set<string>>();
  const pinsByFn = new Map<Node | null, Set<string>>();
  const setFor = (m: Map<Node | null, Set<string>>, k: Node | null) => {
    if (!m.has(k)) m.set(k, new Set());
    return m.get(k) as Set<string>;
  };
  const scopeOf = (ancestors: Node[]) => {
    for (let i = ancestors.length - 1; i >= 0; i--) if (isFn(ancestors[i])) return ancestors[i];
    return null;
  };
  // Bindings first (declarations precede their uses in every shape we accept).
  walk(ast, (n, ancestors) => {
    if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || !n.init) return;
    const scope = scopeOf(ancestors);
    if (isDomainUrlValue(n.init, text, setFor(boundByFn, scope))) {
      setFor(boundByFn, scope).add(n.id.name);
    }
    const init = n.init.type === 'AwaitExpression' ? n.init.argument : n.init;
    if (init.type === 'CallExpression' && calleeName(init) === 'publicCurlResolveArgs') {
      setFor(pinsByFn, scope).add(n.id.name);
    }
  });
  const boundAt = (ancestors: Node[]) => {
    // Names visible here: this function's and every enclosing one's.
    const out = new Set<string>(boundByFn.get(null) ?? []);
    for (const a of ancestors) if (isFn(a)) for (const nm of boundByFn.get(a) ?? []) out.add(nm);
    return out;
  };
  const pinsAt = (ancestors: Node[]) => {
    const out = new Set<string>(pinsByFn.get(null) ?? []);
    for (const a of ancestors) if (isFn(a)) for (const nm of pinsByFn.get(a) ?? []) out.add(nm);
    return out;
  };

  walk(ast, (n, ancestors) => {
    const opener = rawOpener(n, bindings);
    if (opener && !allowed.includes(opener)) {
      const { name } = enclosing(ancestors);
      findings.push({ rule: 1, where: `${path}:${name}`, detail: opener });
    }

    // Rule 4: per request call.
    if (n.type === 'CallExpression') {
      const name = calleeName(n);
      const bound = boundAt(ancestors);
      const where = `${path}:${enclosing(ancestors).name}`;
      const argv = curlArgv(n);
      if (argv) {
        const hasUrl = argv.elements.some((e: Node) => isDomainUrlValue(e, text, bound));
        if (hasUrl && !curlPinned(argv, pinsAt(ancestors))) {
          findings.push({ rule: 4, where, detail: 'curl of the domain without --resolve' });
        }
      } else if (
        name &&
        !HELPER_NAMES.has(name) &&
        (/fetch/i.test(name) || opener) &&
        n.arguments.some((a: Node) => isDomainUrlValue(a, text, bound))
      ) {
        findings.push({ rule: 4, where, detail: `${name}() of the domain` });
      }
    }

    if (!isDomainUrlLiteral(n, text)) return;
    const parent = ancestors[ancestors.length - 1];
    // A concatenation counts once, at its outermost `+`.
    if (
      n.type === 'BinaryExpression' &&
      parent?.type === 'BinaryExpression' &&
      parent.operator === '+'
    ) {
      return;
    }
    const printed =
      parent?.type === 'CallExpression' &&
      parent.callee.type === 'Identifier' &&
      parent.callee.name === 'link';
    if (printed) return;
    // A curl already pinned: `--resolve` in the command string, or in the
    // argv array beside the URL (a server-side curl to its own 127.0.0.1).
    if (/--resolve/.test(text.slice(n.start, n.end))) return;
    if (
      parent?.type === 'ArrayExpression' &&
      parent.elements.some((e: Node) => e?.type === 'Literal' && e.value === '--resolve')
    ) {
      return;
    }
    const { name, node } = enclosing(ancestors);
    const key = `${path}:${name}`;
    const refs = referencedNames(node, ast);
    for (const sys of SYSTEM_FETCHES) {
      if (refs.has(sys)) findings.push({ rule: 3, where: key, detail: `references ${sys}` });
    }
    if (NOT_A_PROBE[key]) {
      exemptKeys.push(key);
      return;
    }
    if (![...HELPER_NAMES].some((h) => refs.has(h))) {
      findings.push({
        rule: 2,
        where: key,
        detail: `${text.slice(n.start, n.end)} without public-domain-probe.js`,
      });
    }
  });
  return { findings, exemptKeys };
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

const results = jsFiles(SRC).map((f) => scan(relative(SRC, f), readFileSync(f, 'utf8')));

describe('census: probes of the app domain resolve through public DNS', () => {
  it('no request to the app domain bypasses public-domain-probe.js', () => {
    const findings = results.flatMap((r) => r.findings);
    expect(findings).toEqual([]);
  });

  it('every NOT_A_PROBE entry still holds a domain URL (no stale exemptions)', () => {
    const seen = new Set(results.flatMap((r) => r.exemptKeys));
    expect(Object.keys(NOT_A_PROBE).filter((k) => !seen.has(k))).toEqual([]);
  });

  it('the raw-opener allowlist names files that still open sockets', () => {
    for (const file of Object.keys(RAW_OPENERS_ALLOWED)) {
      expect(readFileSync(join(SRC, file), 'utf8')).toMatch(/new Agent\(|tls\.connect\(/);
    }
  });
});

describe('census bite: the scanner catches what it claims to', () => {
  const bite = (src: string, path = 'lib/x.js') =>
    scan(path, src)
      .findings.map((f) => f.rule)
      .sort();

  it('rule 2 + 3: a bare fetch of the domain (the pre-fix status shape)', () => {
    expect(
      bite(`export async function checkRemoteHealth(domain, deps = {}) {
        const url = \`https://\${domain}/api/health/ready\`;
        return probe(url, deps.fetch || fetch);
      }`),
    ).toEqual([2, 3]);
  });

  it('rule 3 + 4: a helper call does not excuse a system fetch beside it', () => {
    expect(
      bite(`async function f(domain) {
        await fetchPublicDomain(\`https://\${domain}/a\`);
        return fetchWithRetry(\`https://\${domain}/b\`);
      }`),
    ).toEqual([3, 3, 4]);
  });

  it('rule 4: one pinned request never excuses a raw one in the same function', () => {
    expect(
      bite(`async function f(domain, fetchFn) {
        await fetchPublicDomain(\`https://\${domain}/a\`);
        return fetchFn(\`https://\${domain}/b\`);
      }`),
    ).toEqual([4]);
  });

  it('rule 4 follows a local binding, new URL(), http:// and concatenation', () => {
    expect(
      bite(`async function f(domain, fetchImpl) {
        await fetchPublicDomain('x');
        const u = new URL('/x', \`http://\${domain}\`);
        return fetchImpl(u);
      }`),
    ).toEqual([4]);
    expect(
      bite(`async function f(envConfig, fetchImpl) {
        await fetchPublicDomain('x');
        return fetchImpl('https://' + envConfig.domain + '/api/health');
      }`),
    ).toEqual([4]);
  });

  it('rule 1: raw openers outside the helper, however they are imported', () => {
    expect(
      bite(`function h(envConfig) { return tls.connect({ host: envConfig.domain }); }`),
    ).toEqual([1]);
    expect(bite(`const a = new undici.Agent({});`)).toEqual([1]);
    expect(bite(`import { connect } from 'node:tls'; connect({});`)).toEqual([1]);
    expect(bite(`import * as h from 'node:https'; h.request('x');`)).toEqual([1]);
    expect(bite(`import h from 'https'; h.get('x');`)).toEqual([1]);
    expect(
      bite(`async function f() { const { Agent: A } = await import('undici'); new A(); }`),
    ).toEqual([1]);
    expect(bite(`import { fetch as uf } from 'undici'; uf('x');`)).toEqual([1]);
    // Not an opener: tls's root store, a non-network module's connect.
    expect(bite(`import tls from 'node:tls'; const r = tls.rootCertificates;`)).toEqual([]);
    expect(bite(`import { connect } from './db.js'; connect();`)).toEqual([]);
  });

  it('rule 2 sees http:// and concatenated domain URLs, once per concatenation', () => {
    expect(bite(`function f(domain) { return 'http://' + domain + '/x' + '/y'; }`)).toEqual([2]);
    expect(bite(`function f(domain) { return \`http://\${domain}/x\`; }`)).toEqual([2]);
  });

  it('rule 2 + 4: an unpinned operator-side curl of the domain', () => {
    expect(
      bite(`async function diag(domain) {
        return run('curl', ['-skv', \`https://\${domain}/api/health\`]);
      }`),
    ).toEqual([2, 4]);
  });

  it('rule 4: a pinned curl does not excuse an unpinned one beside it', () => {
    expect(
      bite(`async function diag(domain) {
        const pin = await publicCurlResolveArgs(domain);
        await run('curl', ['-skv', ...pin, \`https://\${domain}/a\`]);
        return run('curl', ['-skv', \`https://\${domain}/b\`]);
      }`),
    ).toEqual([4]);
  });

  it('passes: the helper, a printed link, a --resolve pinned curl, a helper-pinned curl', () => {
    expect(
      bite(`export async function checkRemoteHealth(domain, deps = {}) {
        const url = \`https://\${domain}/api/health/ready\`;
        return probe(url, deps.fetch || ((u, i) => fetchPublicDomain(u, i)));
      }`),
    ).toEqual([]);
    expect(bite(`function show(domain) { log(link(\`https://\${domain}\`)); }`)).toEqual([]);
    expect(
      bite(
        `const cmd = (domain) => \`curl -sk --resolve \${domain}:443:127.0.0.1 https://\${domain}/x\`;`,
      ),
    ).toEqual([]);
    expect(
      bite(`async function diag(domain) {
        const pin = await publicCurlResolveArgs(domain);
        return run('curl', ['-skv', ...pin, \`https://\${domain}/api/health\`]);
      }`),
    ).toEqual([]);
  });
});
