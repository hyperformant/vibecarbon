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
 * never count. Three rules:
 *
 * 1. Raw socket and HTTP openers (`tls.connect`, `net.connect`,
 *    `https.request`/`get`, `http.request`/`get`, `new Agent(`) live only in
 *    the helper, plus the one global dispatcher in fetch-retry.js (provider
 *    APIs, never the app's domain). A new opener is a new way to reach the
 *    domain that the helper does not govern.
 * 2. Every `https://${domain}` URL (a template literal whose host expression
 *    names a domain) is printed (`link(...)`), a curl already pinned with
 *    `--resolve` (the server-side curls of failover and compose-ha), a value written into config (the NOT_A_PROBE
 *    table, each with its reason), or sits in a function that reaches the
 *    domain through the helper.
 * 3. A function holding such a URL never touches the bare global `fetch` or
 *    `fetchWithRetry`: both resolve through the system resolver. This is the
 *    exact shape status had (`deps.fetch || fetch`).
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
  [HELPER_FILE]: { calls: ['new Agent', 'tls.connect'], why: 'the helper itself' },
  'lib/fetch-retry.js': {
    calls: ['new Agent'],
    why: 'the process-wide keep-alive dispatcher for provider and DNS APIs, never the app domain',
  },
};

/** `file:fn` holding an `https://${domain}` URL that is not a request, and why. */
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

function rawOpener(n: Node): string | null {
  if (n.type === 'NewExpression') {
    const c = n.callee;
    const name = c.type === 'Identifier' ? c.name : c.property?.name;
    return name === 'Agent' ? 'new Agent' : null;
  }
  if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression') return null;
  const obj = n.callee.object;
  const prop = n.callee.property?.name;
  const objName = obj.type === 'Identifier' ? obj.name : null;
  const pairs: Record<string, string[]> = {
    tls: ['connect'],
    net: ['connect', 'createConnection'],
    https: ['request', 'get'],
    http: ['request', 'get'],
  };
  if (objName && pairs[objName]?.includes(prop)) return `${objName}.${prop}`;
  return null;
}

/** A template literal holding `https://${<something naming a domain>}`. */
function isDomainUrl(n: Node, text: string): boolean {
  if (n.type !== 'TemplateLiteral') return false;
  return n.expressions.some((expr: Node, i: number) => {
    const before = n.quasis[i].value.cooked ?? n.quasis[i].value.raw;
    if (!/https:\/\/$/.test(before)) return false;
    return /domain/i.test(text.slice(expr.start, expr.end));
  });
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

interface Finding {
  rule: 1 | 2 | 3;
  where: string;
  detail: string;
}

/** Run the three rules over one source file (the bite test calls it on synthetic sources). */
function scan(path: string, text: string): { findings: Finding[]; exemptKeys: string[] } {
  const ast = parseAst(text);
  const findings: Finding[] = [];
  const exemptKeys: string[] = [];
  const allowed = RAW_OPENERS_ALLOWED[path]?.calls ?? [];
  walk(ast, (n, ancestors) => {
    const opener = rawOpener(n);
    if (opener && !allowed.includes(opener)) {
      const { name } = enclosing(ancestors);
      findings.push({ rule: 1, where: `${path}:${name}`, detail: opener });
    }
    if (!isDomainUrl(n, text)) return;
    const parent = ancestors[ancestors.length - 1];
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
  const bite = (src: string, path = 'lib/x.js') => scan(path, src).findings.map((f) => f.rule);

  it('rule 2 + 3: a bare fetch of the domain (the pre-fix status shape)', () => {
    expect(
      bite(`export async function checkRemoteHealth(domain, deps = {}) {
        const url = \`https://\${domain}/api/health/ready\`;
        return probe(url, deps.fetch || fetch);
      }`),
    ).toEqual([3, 2]);
  });

  it('rule 3 alone: a helper import does not excuse a system fetch beside it', () => {
    expect(
      bite(`async function f(domain) {
        await fetchPublicDomain(\`https://\${domain}/a\`);
        return fetchWithRetry(\`https://\${domain}/b\`);
      }`),
    ).toEqual([3, 3]);
  });

  it('rule 1: a raw tls.connect or Agent outside the helper', () => {
    expect(
      bite(`function h(envConfig) { return tls.connect({ host: envConfig.domain }); }`),
    ).toEqual([1]);
    expect(bite(`const a = new undici.Agent({});`)).toEqual([1]);
  });

  it('rule 2: an unpinned operator-side curl of the domain', () => {
    expect(
      bite(`async function diag(domain) {
        return run('curl', ['-skv', \`https://\${domain}/api/health\`]);
      }`),
    ).toEqual([2]);
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
