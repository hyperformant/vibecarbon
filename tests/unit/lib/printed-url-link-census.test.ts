/**
 * Census: every URL the CLI prints goes through link() (src/lib/colors.js).
 *
 * clack wraps note and log text at the terminal width. A plain URL in a
 * narrow terminal is split across two box lines with border characters
 * between the halves, and clicking either half opens a broken URL. link()
 * prints an OSC 8 hyperlink where the terminal renders one (clack keeps the
 * span whole) and the plain URL everywhere else.
 *
 * Found with vite's parseAst over every tracked `.js` file under `src/`, so
 * comments never count. Three rules:
 *   1. A string or template that spells `https://<host>` is inside the
 *      arguments of a link() call, or it is exempt below.
 *   2. A URL held in a named constant (`const PRICING_URL = 'https://...'`,
 *      `static PRICING_URL`, `{ statusUrl: 'https://...' }`) is data, not a
 *      message, so the literal itself passes; the name then counts as a URL,
 *      and every place that interpolates it into text (a template, a `+`
 *      concatenation, or a console/clack print call) must be inside link().
 *   3. Every allowlist entry still matches a literal, so the list cannot rot.
 *
 * Exempt without an entry: a URL after `curl` or `wget` on the same line (a
 * copyable shell command, see copyable-command-census.test.ts), a provider
 * API host (`https://api.<...>`) and an S3 endpoint host (request targets).
 * Placeholders such as `https://<your-domain>` and `(without https://)` are
 * not URLs and never match.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

/** A real, clickable https URL: a host (or a `${...}` host) right after the scheme. */
const URL_RE = /https:\/\/(?:[A-Za-z0-9]|\{\*\})[^\s'"`)<>\]]*/g;

/** Request targets, never printed: provider APIs and S3 endpoints. */
const REQUEST_HOSTS =
  /^https:\/\/(?:api\.|[\w-]+\.(?:linodeobjects\.com|vultrobjects\.com|digitaloceanspaces\.com|your-objectstorage\.com)|s3\.[\w-]+\.scw\.cloud)/;

/** The command a URL sits in: the text before it on its line names a downloader. */
const SHELL_COMMAND = /\b(?:curl|wget)\b[^\n]*$/;

/**
 * Literals that spell a URL and are never printed, or printed only through a
 * path that must stay plain. Keyed `file scope url`: the scope is the nearest
 * named function, const or class member around the literal (see scopeOf),
 * and the URL is as the census extracts it, a `${...}` written `{*}`. A rule 2
 * read is keyed `file scope NAME` instead.
 */
const ALLOW: { why: string; sites: string[] }[] = [
  {
    why: 'request or probe target the CLI fetches or hands to curl, never printed',
    sites: [
      'src/status.js url https://{*}/api/health/ready',
      'src/failover.js promotedProbeArgv https://{*}{*}',
      'src/lib/deploy/orchestrator.js url https://{*}/api/health',
      'src/lib/deploy/orchestrator.js curlVerbose https://{*}/api/health',
      'src/lib/deploy/orchestrator.js curlPodIp https://{*}/api/health',
      'src/lib/licensing/check.js base https://vibecarbon.com',
      'src/lib/licensing/bind.js base https://vibecarbon.com',
      'src/lib/telemetry/index.js apiBase https://vibecarbon.com',
      'src/lib/telemetry/update-check.js base https://vibecarbon.com',
      'src/lib/ci-setup.js res https://ghcr.io/token?scope=repository:{*}/{*}:pull',
      'src/lib/ci-setup.js url https://ghcr.io/v2/{*}/{*}/manifests/{*}',
      'src/lib/providers/linode-objectstorage.js mintAppKey https://{*}',
      'src/add.js GITHUB_RAW_BASE https://raw.githubusercontent.com/{*}/{*}',
      'src/lib/deploy/k8s/k3s.js CERT_MANAGER_URL https://github.com/cert-manager/cert-manager/releases/download/{*}/cert-manager.yaml',
      'src/lib/deploy/k8s/k3s.js patched https://{*}:6443',
      'src/lib/deploy/compose/index.js registryHost https://index.docker.io/v1/',
    ],
  },
  {
    why: 'config value for an env file, manifest, build arg or CORS rule, not a message',
    sites: [
      'src/configure.js base https://{*}',
      'src/create.js generateEnvLocal https://plausible.io/js/script.js',
      'src/lib/deploy/bundle.js renderBundle https://{*}',
      'src/lib/deploy/compose/build-args.js collectComposeBuildArgs https://{*}',
      'src/lib/deploy/k8s/k3s.js buildK3sBuildInputs https://{*}',
      'src/lib/deploy/k8s/k3s.js configYaml https://{*}',
      'src/lib/deploy/k8s/k3s.js applyK3sManifests https://{*}',
      'src/lib/deploy/k8s/gitops-deploy.js perEnvVars https://{*}',
      'src/lib/deploy/orchestrator.js envCorsOrigins https://{*}',
    ],
  },
  {
    why: 'the default of a text prompt the operator edits in place; an escape sequence there would be edited too',
    sites: ['src/configure.js scriptUrl https://plausible.io/js/script.js'],
  },
  {
    why: 'cloud-init or README text written to a file, never a terminal',
    sites: [
      'src/lib/iac/programs/digitalocean-compose.js DOCKER_INSTALL_RUNCMD https://download.docker.com/linux/ubuntu',
      'src/lib/iac/programs/linode-compose.js DOCKER_INSTALL_RUNCMD https://download.docker.com/linux/ubuntu',
      'src/lib/iac/programs/scaleway-compose.js DOCKER_INSTALL_RUNCMD https://download.docker.com/linux/ubuntu',
      'src/lib/iac/programs/vultr-compose.js DOCKER_INSTALL_RUNCMD https://download.docker.com/linux/ubuntu',
      'src/create.js generateReadme https://www.postgresql.org/docs/',
      'src/create.js generateReadme https://hono.dev',
      'src/create.js generateReadme https://vitejs.dev',
    ],
  },
  {
    why: 'help spec text, also the source of the generated CLI docs; renderHelp (src/lib/cli/help.js) links it at print time',
    sites: ['src/telemetry.js SPEC https://vibecarbon.com/docs/telemetry'],
  },
  {
    why: 'thrown Error message: it also reaches crash telemetry (sanitizeError keeps the message), so it stays plain text',
    sites: [
      'src/lib/ci-setup.js ensureCIImageReady https://cli.github.com/',
      'src/lib/iac/create-timeout.js status statusUrl',
    ],
  },
];

const ALLOWED = new Map(ALLOW.flatMap((g) => g.sites.map((s) => [s, g.why] as const)));

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

function calleeName(call: Node): string | null {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property?.type === 'Identifier') {
    return c.property.name;
  }
  return null;
}

const isFn = (n: Node) =>
  n.type === 'FunctionDeclaration' ||
  n.type === 'FunctionExpression' ||
  n.type === 'ArrowFunctionExpression';

const isLinkCall = (n: Node) => n.type === 'CallExpression' && calleeName(n) === 'link';
const insideLink = (ancestors: Node[]) => ancestors.some(isLinkCall);

/** console.*, clack's p.log.* / p.note / p.cancel / ..., a spinner's start/stop/message. */
const PRINT_CALLS = new Set([
  'log',
  'error',
  'warn',
  'info',
  'message',
  'success',
  'step',
  'note',
  'cancel',
  'intro',
  'outro',
  'start',
  'stop',
]);

/** The text of a string literal or template, `${...}` written as `{*}`. */
function textOf(n: Node): string | null {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') {
    return n.quasis.map((q: Node) => q.value.cooked ?? q.value.raw).join('{*}');
  }
  return null;
}

/** The name a literal is the whole value of, when it is a named constant. */
function constantName(parent: Node | undefined, n: Node): string | null {
  if (!parent) return null;
  if (
    parent.type === 'VariableDeclarator' &&
    parent.init === n &&
    parent.id?.type === 'Identifier'
  ) {
    return parent.id.name;
  }
  if (
    (parent.type === 'PropertyDefinition' || parent.type === 'Property') &&
    parent.value === n &&
    !parent.computed &&
    parent.key?.type === 'Identifier'
  ) {
    return parent.key.name;
  }
  return null;
}

/** The name an expression reads: `X` or `a.b.X`. */
function readName(n: Node): string | null {
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'MemberExpression' && !n.computed && n.property?.type === 'Identifier') {
    return n.property.name;
  }
  return null;
}

/**
 * The nearest named declaration around a literal: a function, a const, a
 * class member. Allowlist keys carry it, so an entry covers one place in a
 * file, not every literal there that spells the same URL.
 */
function scopeOf(ancestors: Node[]): string {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'FunctionDeclaration' && a.id?.name) return a.id.name;
    if (a.type === 'VariableDeclarator' && a.id?.type === 'Identifier') return a.id.name;
    if ((a.type === 'MethodDefinition' || a.type === 'PropertyDefinition') && a.key?.name) {
      return a.key.name;
    }
  }
  return '<module>';
}

type Scan = {
  /** URL literals printed raw: rule 1. */
  raw: string[];
  /** Allowlist keys this file used. */
  allowedHit: string[];
  /** Named URL constants this file defines: rule 2. */
  constants: { name: string; site: string }[];
  /** Names read in text or a print call, outside link(), with where. */
  interpolated: { name: string; key: string; site: string }[];
};

function scan(file: string, text: string): Scan {
  const out: Scan = { raw: [], allowedHit: [], constants: [], interpolated: [] };
  const lineOf = (n: Node) => text.slice(0, n.start).split('\n').length;

  walk(parseAst(text), (n, ancestors) => {
    // Rule 2's read side: a name interpolated into printed text.
    const parent = ancestors[ancestors.length - 1];
    if (parent && !insideLink(ancestors)) {
      const name = readName(n);
      const inText =
        (parent.type === 'TemplateLiteral' && parent.expressions.includes(n)) ||
        (parent.type === 'BinaryExpression' && parent.operator === '+') ||
        (parent.type === 'CallExpression' &&
          parent.arguments.includes(n) &&
          PRINT_CALLS.has(calleeName(parent) ?? ''));
      if (name && inText) {
        out.interpolated.push({
          name,
          key: `${file} ${scopeOf(ancestors)} ${name}`,
          site: `${file}:${lineOf(n)}`,
        });
      }
    }

    const value = textOf(n);
    if (value === null || !value.includes('https://')) return;
    if (insideLink(ancestors)) return;
    for (const m of value.matchAll(URL_RE)) {
      // Sentence punctuation after a URL is not part of it.
      const url = m[0].replace(/[.,;:]+$/, '');
      const before = value.slice(0, m.index);
      if (SHELL_COMMAND.test(before.slice(before.lastIndexOf('\n') + 1))) continue;
      if (REQUEST_HOSTS.test(url)) continue;
      const key = `${file} ${scopeOf(ancestors)} ${url}`;
      if (ALLOWED.has(key)) {
        out.allowedHit.push(key);
        continue;
      }
      // Only a literal that is the URL and nothing else is data; a message
      // held in a constant (`const TERMS_LINE = 'Terms: ... https://...'`)
      // is still a message.
      const name = value.trim() === url && !ancestors.some(isFn) ? constantName(parent, n) : null;
      if (name) {
        out.constants.push({ name, site: `${file}:${lineOf(n)}` });
        continue;
      }
      out.raw.push(`${file}:${lineOf(n)}: ${scopeOf(ancestors)} ${url}`);
    }
  });
  return out;
}

const files = execFileSync('git', ['ls-files', 'src/*.js', 'src/**/*.js'], {
  cwd: ROOT,
  encoding: 'utf-8',
})
  .split('\n')
  .filter(Boolean);

function census(sources: [string, string][]) {
  const scans = sources.map(([f, t]) => scan(f, t));
  const constants = new Set(scans.flatMap((s) => s.constants.map((c) => c.name)));
  const reads = scans.flatMap((s) => s.interpolated).filter((i) => constants.has(i.name));
  return {
    raw: scans.flatMap((s) => s.raw),
    unlinked: reads.filter((i) => !ALLOWED.has(i.key)).map((i) => `${i.site}: ${i.key}`),
    allowedHit: new Set([
      ...scans.flatMap((s) => s.allowedHit),
      ...reads.filter((i) => ALLOWED.has(i.key)).map((i) => i.key),
    ]),
    constants: scans.flatMap((s) => s.constants),
  };
}

describe('every printed URL goes through link()', () => {
  const result = census(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf-8')]));

  it('walks the CLI source', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(result.constants.length).toBeGreaterThan(0);
  });

  it('no string in src/ prints a raw https URL', () => {
    expect(result.raw, 'wrap the URL in link() from src/lib/colors.js').toEqual([]);
  });

  it('a named URL constant is only ever printed through link()', () => {
    expect(result.unlinked, 'print it as link(NAME)').toEqual([]);
  });

  it('every allowlist entry still matches a literal', () => {
    expect([...ALLOWED.keys()].filter((k) => !result.allowedHit.has(k))).toEqual([]);
  });

  it('catches the shapes it is for', () => {
    const one = (src: string) => census([['src/x.js', src]]);
    // A raw URL in a message, plain or styled, static or with a host from a variable.
    expect(one("p.log.info('see https://example.com/docs');").raw).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(one("p.note(`${c.info('https://example.com')}`);").raw).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(one('lines.push(`Open: https://${domain}`);').raw).toHaveLength(1);
    // A URL constant printed without link().
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    const docsRaw = "const DOCS_URL = 'https://example.com'; console.log(`Docs: ${DOCS_URL}`);";
    expect(one(docsRaw).unlinked).toHaveLength(1);
    expect(
      one("class P { static PRICING_URL = 'https://example.com'; } p.note(P.PRICING_URL);")
        .unlinked,
    ).toHaveLength(1);

    const clean = (src: string) => {
      const r = one(src);
      return [...r.raw, ...r.unlinked];
    };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(clean("p.log.info(`see ${c.info(link('https://example.com'))}`);")).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(clean('lines.push(`Open: ${link(`https://${domain}`)}`);')).toEqual([]);
    const docsLinked =
      "const DOCS_URL = 'https://example.com'; " +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'console.log(`Docs: ${link(DOCS_URL)}`);';
    expect(clean(docsLinked)).toEqual([]);
    expect(clean("p.log.info('Upgrade:  curl -fsSL https://get.pulumi.com | sh');")).toEqual([]);
    expect(clean("fetch('https://api.example.com/v1/x');")).toEqual([]);
    expect(clean("p.log.info('Endpoint: https://<your-domain>/api (without https://)');")).toEqual(
      [],
    );
    // Comments never count.
    expect(clean('// see https://example.com\nconst x = 1;')).toEqual([]);
  });
});
