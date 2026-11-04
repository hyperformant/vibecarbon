/**
 * Census: `vibecarbon status` lists a cluster's pods, nodes and jobs in ONE
 * place, the snapshot helper (src/lib/status/cluster-snapshot.js), once per
 * cluster per run. Every row (containers, node readiness, the backup job, the
 * db pod name the psql and log execs target) reads that one snapshot.
 *
 * Why: status used to send about 16 kubectl calls to a master per run, up to
 * 7 at once, each capped at 10 s. On a 2-vCPU master any slow moment showed up
 * as a false "ssh timeout" (DO k8s-ha e2e, the live primary reported down
 * while other execs to it succeeded). A new `get pods` beside the snapshot
 * grows that fan-out back, one probe at a time.
 *
 * Fails on, in any status file other than the helper: an argv `'get'` naming
 * pods, nodes or jobs; a shell string `kubectl ... get pods|nodes|jobs`; a
 * call to ssh.js's getPostgresPod (a `get pods -l` by another name).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const HELPER = 'src/lib/status/cluster-snapshot.js';

/** Every module `vibecarbon status` owns. */
const STATUS_FILES = [
  'src/status.js',
  ...readdirSync(join(ROOT, 'src/lib/status'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/lib/status/${f}`),
];

/** The source with comments blanked, string literals kept (a URL's `//` is not a comment). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const KIND = String.raw`(?:po|pods?|no|nodes?|jobs?)(?:\.batch)?`;
/** A kubectl resource argument naming one of the listed kinds: `pods`, `pod/x`, `nodes,pods`. */
const RESOURCE_ARG = new RegExp(String.raw`^(?:[\w.]+,)*${KIND}(?:,[\w.]+)*(?:\/.*)?$`);
/** `kubectl [flags] get [flags] pods` inside a shell string. */
const SHELL_GET = new RegExp(
  String.raw`\bkubectl\b[^\n]*?\bget\s+(?:-{1,2}[\w-]+(?:[ =]\S+)?\s+)*(?:[\w.]+,)*${KIND}\b`,
);
const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Each listing of pods/nodes/jobs in `src`, as a short description. */
function findClusterListings(src: string): string[] {
  const code = stripComments(src);
  const found: string[] = [];
  if (/\bgetPostgresPod\b/.test(code)) found.push('getPostgresPod');
  for (const m of code.matchAll(LITERAL)) {
    if (SHELL_GET.test(m[2])) found.push(`shell: ${m[2]}`);
    if (m[2] !== 'get' || m.index === undefined) continue;
    // The rest of this argv array (or call) after its 'get'.
    const rest = code.slice(m.index + m[0].length);
    const close = rest.search(/[\])]/);
    const args = [...(close < 0 ? rest : rest.slice(0, close)).matchAll(LITERAL)].map((a) => a[2]);
    const kind = args.find((a) => RESOURCE_ARG.test(a));
    if (kind) found.push(`argv: get ${kind}`);
  }
  return found;
}

describe('census: status lists pods, nodes and jobs only through the snapshot helper', () => {
  it('scans the status modules (a rename cannot empty it)', () => {
    expect(STATUS_FILES).toEqual(
      expect.arrayContaining([
        'src/status.js',
        HELPER,
        'src/lib/status/remote-containers.js',
        'src/lib/status/backup-health.js',
      ]),
    );
  });

  it('the helper itself is the one listing (positive control)', () => {
    expect(findClusterListings(readFileSync(join(ROOT, HELPER), 'utf8'))).toEqual([
      'argv: get nodes,pods,jobs',
    ]);
  });

  it.each(STATUS_FILES.filter((f) => f !== HELPER))('%s lists nothing itself', (file) => {
    expect(findClusterListings(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });
});

describe('census bite: the detector catches every shape it guards', () => {
  it.each([
    ["sshKubectl(ip, key, ['get', 'pods', '-A', '-o', 'json'])", 'argv: get pods'],
    ["run(['get', 'nodes', '-o', 'json'])", 'argv: get nodes'],
    ["kube(['get', 'jobs', '-n', NAMESPACE, '-o', 'json'])", 'argv: get jobs'],
    ["kube(['-n', NS, 'get', 'pod', pod, '-o', 'jsonpath={.status}'])", 'argv: get pod'],
    ["kube(['get', 'pod/db-0', '-o', 'json'])", 'argv: get pod/db-0'],
    ["kube(['get', 'jobs.batch', '-A'])", 'argv: get jobs.batch'],
    ["kube(['get', 'configmap,pods', '-A'])", 'argv: get configmap,pods'],
    ['const pod = await getPostgresPod(ip, key());', 'getPostgresPod'],
    [
      "bash(ip, 'kubectl -n vibecarbon get pods -o name')",
      'shell: kubectl -n vibecarbon get pods -o name',
    ],
    ['bash(ip, `kubectl get --no-headers nodes`)', 'shell: kubectl get --no-headers nodes'],
  ])('flags %s', (src, expected) => {
    expect(findClusterListings(src)).toEqual([expected]);
  });

  it.each([
    "// a comment may say kubectl get pods, or getPostgresPod\nrun(['exec', '-n', NS, pod, '--', 'psql'])",
    "/* ['get', 'pods'] */ run(['logs', '-n', NS, pod, '--timestamps'])",
    "kube(['get', 'configmap/vibecarbon-config', '-o', 'json'])",
    "fetch('https://example.invalid/get') // 'get', 'pods'",
    "const why = 'get pods from the snapshot';",
  ])('passes %s', (src) => {
    expect(findClusterListings(src)).toEqual([]);
  });
});
