/**
 * Census: no code restarts Traefik without first waiting out live ACME
 * challenges.
 *
 * Traefik serves the HTTP-01 token Let's Encrypt fetches for the k8s
 * Certificate, which the deploy creates before it restarts Traefik (k3s.js
 * applyK3sManifests, step 5 then step 10). A restart under a live challenge
 * closes port 80 while Let's Encrypt may be validating, and the order fails.
 * Every site that deletes the Traefik pod or restarts its Deployment must
 * call awaitAcmeChallengesSettled (acme-challenges.js) earlier in the same
 * function. Hetzner k8s-ha, CI run 42426102569, had nothing stopping it.
 *
 * Walks src/ and the template's deploy surfaces (scripts, workflows,
 * cloud-init). The inventory pins the sites there are today, so a new one is
 * reviewed against the rule the day it appears. The pilot standby's skip
 * (self-signed issuer, no challenge) is a runtime branch inside the one
 * guarded function, covered by k3s-apply-manifests-ordering.test.ts.
 * Each detector is bitten by a synthetic source below.
 *
 * Out of scope by design: compose's `docker compose restart traefik`
 * (compose/tls-restore.js, acme-role.js, scale.js). There Traefik is its own
 * ACME client and holds no cert-manager Challenge; it restarts to load a
 * certificate the restore just wrote, or to start or stop issuance on
 * purpose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const ROOTS = ['src', 'carbon/scripts', 'carbon/.github/workflows', 'carbon/cloud-init'];
const SKIP = new Set(['node_modules', 'dist', 'coverage']);
const EXT = /\.(m?js|sh|ya?ml)$/;
const WAIT = 'awaitAcmeChallengesSettled(';

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

/** Drop comment lines (JS `//`, `*` doc lines, shell/YAML `#`): history may name a restart. */
function codeLines(source: string): string[] {
  return source.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*|#)/.test(l) ? '' : l));
}

/**
 * Lines (0-based) that restart Traefik: a pod delete selecting the Traefik
 * label, or a rollout restart / pod delete naming the Traefik Deployment or
 * its pods. A JS argv array spreads one command over several lines, so a
 * delete is matched within the few lines around the selector.
 */
function traefikRestartSites(source: string): number[] {
  const lines = codeLines(source);
  const sites: number[] = [];
  lines.forEach((line, i) => {
    const near = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
    const selector = /app=vibecarbon-traefik/.test(line);
    const deletes = /(['"\s])delete(['"\s])/.test(near) && /(['"\s])pods?(['"\s])/.test(near);
    const rolloutRestart =
      /rollout['",\s]+restart/.test(line) && /(deployment|deploy)\/traefik\b/.test(line);
    const rolloutRestartArgv =
      /(deployment|deploy)\/traefik\b/.test(line) &&
      /['"]rollout['"]/.test(near) &&
      /['"]restart['"]/.test(near);
    if ((selector && deletes) || rolloutRestart || rolloutRestartArgv) sites.push(i);
  });
  return sites;
}

/**
 * Is the site guarded: does the wait run earlier in the same top-level
 * function? The function starts at the last `function` declaration (or
 * top-level arrow) at column 0 before the site.
 */
function guarded(source: string, site: number): boolean {
  const lines = codeLines(source);
  let start = 0;
  for (let i = site; i >= 0; i--) {
    if (
      /^(export\s+)?(async\s+)?function\b|^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(
        lines[i],
      )
    ) {
      start = i;
      break;
    }
  }
  return lines.slice(start, site).some((l) => l.includes(WAIT));
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const found = files.flatMap((f) => {
  const src = readFileSync(f, 'utf-8');
  return traefikRestartSites(src).map((line) => ({
    file: relative(ROOT, f),
    line: line + 1,
    ok: guarded(src, line),
  }));
});

describe('every Traefik restart waits out live ACME challenges first', () => {
  it('walks a real tree', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('src/lib/deploy/k8s/k3s.js'))).toBe(true);
  });

  it('the inventory: the one Traefik restart is applyK3sManifests step 10', () => {
    expect([...new Set(found.map((s) => s.file))]).toEqual(['src/lib/deploy/k8s/k3s.js']);
  });

  it('every site calls the challenge wait earlier in the same function', () => {
    const unguarded = found.filter((s) => !s.ok).map((s) => `${s.file}:${s.line}`);
    expect(unguarded, 'Traefik restarted without awaitAcmeChallengesSettled first').toEqual([]);
  });
});

describe('the detectors bite', () => {
  const restartArgv = [
    '    await runKubectlWithRetry(',
    '      [',
    "        '-n',",
    "        'vibecarbon',",
    "        'delete',",
    "        'pod',",
    "        '-l',",
    "        'app=vibecarbon-traefik',",
    '      ],',
    '    );',
  ].join('\n');

  it('finds a JS argv pod delete by the Traefik selector', () => {
    expect(traefikRestartSites(restartArgv)).toHaveLength(1);
  });

  it('finds a shell rollout restart of the Traefik Deployment', () => {
    expect(
      traefikRestartSites('kubectl -n vibecarbon rollout restart deployment/traefik\n'),
    ).toHaveLength(1);
  });

  it('finds a JS argv rollout restart of the Traefik Deployment', () => {
    expect(
      traefikRestartSites("run(['kubectl', 'rollout',\n 'restart',\n 'deploy/traefik']);\n"),
    ).toHaveLength(1);
  });

  it('ignores a rollout status wait and a comment that names the restart', () => {
    expect(
      traefikRestartSites(
        "// kubectl delete pod -l app=vibecarbon-traefik\nrun(['rollout', 'status', 'deployment/traefik']);\n",
      ),
    ).toEqual([]);
  });

  it('a wait in the same function guards the site', () => {
    const src = [
      'export async function applyK3sManifests() {',
      `  await ${WAIT}{ runKubectl, namespaces });`,
      restartArgv,
      '}',
    ].join('\n');
    const [site] = traefikRestartSites(src);
    expect(guarded(src, site)).toBe(true);
  });

  it('a wait AFTER the restart does not', () => {
    const src = [
      'export async function applyK3sManifests() {',
      restartArgv,
      `  await ${WAIT}{ runKubectl, namespaces });`,
      '}',
    ].join('\n');
    const [site] = traefikRestartSites(src);
    expect(guarded(src, site)).toBe(false);
  });

  it('a wait in ANOTHER function does not', () => {
    const src = [
      'async function other() {',
      `  await ${WAIT}{ runKubectl, namespaces });`,
      '}',
      'export async function applyK3sManifests() {',
      restartArgv,
      '}',
    ].join('\n');
    const [site] = traefikRestartSites(src);
    expect(guarded(src, site)).toBe(false);
  });

  it('a wait only named in a comment does not', () => {
    const src = [
      'export async function applyK3sManifests() {',
      `  // ${WAIT} would go here`,
      restartArgv,
      '}',
    ].join('\n');
    const [site] = traefikRestartSites(src);
    expect(guarded(src, site)).toBe(false);
  });
});
