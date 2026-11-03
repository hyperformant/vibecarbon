/**
 * Census: nothing changes a cert-manager Deployment after its apply.
 *
 * The upstream manifest's container args are a plain list, so every
 * client-side re-apply replaced them, and a post-apply patch put them back:
 * the controller rolled twice per deploy, warm redeploys included, and a
 * controller handoff can miss a restored Secret/vibecarbon-tls and issue a
 * new certificate (DO k8s-ha e2e, 2026-11). Every setting now renders into
 * the one apply (carbon/scripts/render-cert-manager.mjs), so an identical
 * re-apply is a no-op. A later patch, set, edit, label, annotate, scale or
 * rollout restart of one of those Deployments would bring the restart back.
 *
 * Walks src/ and the template's deploy surfaces (scripts, workflows,
 * cloud-init, k8s): any kubectl argv array (JS) or kubectl line (shell,
 * YAML) that mutates in place and names the cert-manager namespace or one
 * of its Deployments fails. Comments may describe the history.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const ROOTS = [
  'src',
  'carbon/scripts',
  'carbon/.github/workflows',
  'carbon/cloud-init',
  'carbon/k8s',
  '.github/workflows',
];
const SKIP = new Set(['node_modules', 'dist', 'coverage']);
const EXT = /\.(m?js|ts|sh|ya?ml)$/;

const MUTATE = /^(patch|set|edit|label|annotate|scale|restart|replace)$/;
const CERT_MANAGER = /^cert-manager(-cainjector|-webhook)?$/;

function* files(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (EXT.test(name)) yield path;
  }
}

const stripComments = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|#)/.test(line))
    .join('\n');

/** JS: innermost array literals whose string elements mutate a cert-manager object. */
function jsOffenders(text: string): string[] {
  const hits: string[] = [];
  for (const [array] of stripComments(text).matchAll(/\[[^[\]]*\]/g)) {
    const strings = [...array.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );
    if (strings.some((s) => MUTATE.test(s)) && strings.some((s) => CERT_MANAGER.test(s))) {
      hits.push(array.replace(/\s+/g, ' '));
    }
  }
  return hits;
}

/** Shell and YAML: one kubectl line that mutates in place in or on cert-manager. */
function shellOffenders(text: string): string[] {
  return stripComments(text)
    .split('\n')
    .filter((line) => {
      if (!/\bkubectl\b/.test(line)) return false;
      const words = line.split(/\s+/);
      return (
        words.some((w) => MUTATE.test(w)) &&
        words.some((w) => CERT_MANAGER.test(w.replace(/^(deploy(ment)?\/|--namespace=)/, '')))
      );
    })
    .map((line) => line.trim());
}

describe('cert-manager Deployments are never changed after their apply', () => {
  it('no code path patches, sets, restarts or scales a cert-manager Deployment', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const path of files(join(ROOT, root))) {
        const text = readFileSync(path, 'utf-8');
        const found = /\.(m?js|ts)$/.test(path) ? jsOffenders(text) : shellOffenders(text);
        for (const hit of found) hits.push(`${relative(ROOT, path)}: ${hit}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the retired test-and-set is gone by name', () => {
    const k3s = readFileSync(join(ROOT, 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(k3s).not.toMatch(/ensureCertManagerControllerFlags/);
  });
});

describe('the detectors catch the shapes this census retired', () => {
  it('the json patch of the controller args', () => {
    const old = `await kubectl(
      [
        '-n',
        'cert-manager',
        'patch',
        'deployment',
        'cert-manager',
        '--type=json',
        '-p',
        JSON.stringify(ops),
      ],
      { env },
    );`;
    expect(jsOffenders(old)).toHaveLength(1);
  });

  it('the control-plane pin over a loop variable', () => {
    const old = `for (const certDeploy of ['cert-manager', 'cert-manager-cainjector', 'cert-manager-webhook']) {
      await runKubectlWithRetry(
        ['-n', 'cert-manager', 'patch', 'deployment', certDeploy, '--type=strategic', '-p', pin],
        { env },
      );
    }`;
    expect(jsOffenders(old)).toHaveLength(1);
  });

  it('shell forms', () => {
    expect(
      shellOffenders('  kubectl -n cert-manager rollout restart deployment/cert-manager'),
    ).toHaveLength(1);
    expect(shellOffenders('kubectl patch deploy/cert-manager-webhook -p "{}"')).toHaveLength(1);
    expect(shellOffenders('kubectl apply -k "$RUNNER_TEMP/cert-manager"')).toHaveLength(0);
    expect(
      shellOffenders(
        'kubectl -n cert-manager wait --for=condition=available deployment/cert-manager',
      ),
    ).toHaveLength(0);
  });

  it('a read or a wait is not an offender', () => {
    expect(
      jsOffenders("['-n', 'cert-manager', 'get', 'deployment', 'cert-manager', '-o', 'json']"),
    ).toEqual([]);
  });
});
