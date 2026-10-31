/**
 * k8s delivers the app image once, by layer delta, into the master's
 * in-cluster registry, and every node pulls it from there (cold-deploy-speed
 * plan, Task 5). This file pins where that delivery sits in the deploy:
 *
 *   - it starts right after the registry pod is Ready (`localRegistry.wait`):
 *     the registry pod is part of k8s/base, so nothing earlier can hold it;
 *   - it is awaited immediately before the step-6 `deployment/app` patch, the
 *     first thing that makes a pod reference the tag, so the CA apply, the
 *     observability apply and the CA rollout overlap it;
 *   - it runs once per image, against the master only, never once per node;
 *   - its base pull starts right after `onInfraReady` (ruling R3), minutes
 *     ahead, and reaches deliverImage as `basePull`.
 *
 * deployK3s and applyK3sManifests can't be driven end to end in a unit test,
 * so this reads their source (vite's parseAst, so comments never count). The
 * behavior of the delivery inside applyK3sManifests (overlap, failure fails
 * the deploy before the patch, a standby delivers nothing) is driven through
 * the spawn-mocked harness in k3s-apply-manifests-ordering.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');

/** The source text of a top-level `export async function <name>(`. */
function fnBody(name: string): string {
  const start = SRC.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = SRC.indexOf('\nexport ', start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
}

/** Index of `needle` in `body`, asserting it is there exactly `times` times. */
function at(body: string, needle: string, times = 1): number {
  expect(body.split(needle).length - 1, `${needle} count`).toBe(times);
  return body.indexOf(needle);
}

describe('applyK3sManifests: the one delivery', () => {
  const body = fnBody('applyK3sManifests');

  it('starts after the registry pod is Ready and is awaited right before the deployment/app patch', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    const registryReady = at(body, '`deploy.${perfPrefix}.localRegistry.wait`');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    const start = at(body, '`deploy.${perfPrefix}.image.deliver`');
    const call = at(body, 'deliverImage({');
    const awaited = at(body, 'await deliveryPromise');
    const patch = at(body, "'deployment/app',\n      '--type=strategic'");
    expect(registryReady).toBeLessThan(start);
    expect(start).toBeLessThan(call);
    // The observability apply runs while the delivery is in flight. (The CA
    // apply and rollout now run alongside the cert-manager chain, from before
    // the base; the app patch also waits for them: clusterAutoscalerReady.)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    const observability = at(body, '`deploy.${perfPrefix}.applyObservability`');
    expect(observability).toBeGreaterThan(call);
    expect(observability).toBeLessThan(awaited);
    expect(awaited).toBeLessThan(patch);
    // Nothing between the await and the patch but the patch itself, the
    // Secret versions it stamps, and the CA barrier.
    expect(body.slice(awaited, patch)).not.toMatch(
      /\bawait (?!deliveryPromise|clusterAutoscalerReady|readAppSecretVersions|runKubectlWithRetry)/,
    );
  });

  it('delivers to the master only, as the k3s runtime, with the tag pods will run', () => {
    const call = body.slice(body.indexOf('deliverImage({'));
    const args = call.slice(0, call.indexOf('})'));
    expect(args).toContain('tag: imageTag');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(args).toContain('sshTarget: `root@${masterIp}`');
    expect(args).toContain("runtime: 'k3s'");
    expect(args).toContain('registryRef: imageTag');
    expect(args).toContain('basePull');
  });

  it('is gated by role: a standby (planImageDelivery deliver false) starts none', () => {
    expect(body).toContain('const { deliver } = planImageDelivery({ role });');
    expect(body).toMatch(/if \(deliver\) \{[\s\S]{0,1200}deliveryPromise = perfAsync\(/);
  });

  it('is never awaited at the end of the function any more', () => {
    const tail = body.slice(body.lastIndexOf('traefik post-apply restart warning'));
    expect(tail).not.toContain('deliveryPromise');
    expect(tail).not.toContain('registryPush');
  });
});

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

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

const LOOP = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement']);
const ITERATORS = new Set(['map', 'forEach', 'flatMap', 'all', 'allSettled']);

describe('once per image, never once per node', () => {
  it('no deliverImage call in k3s.js sits inside a loop or an iteration over nodes', () => {
    const calls: Node[][] = [];
    walk(parseAst(SRC), (n, ancestors) => {
      if (n.type !== 'CallExpression') return;
      if (n.callee?.type === 'Identifier' && n.callee.name === 'deliverImage')
        calls.push(ancestors);
    });
    expect(calls).toHaveLength(1);
    const inLoop = calls[0].some(
      (a) =>
        LOOP.has(a.type) ||
        (a.type === 'CallExpression' &&
          a.callee?.type === 'MemberExpression' &&
          ITERATORS.has(a.callee.property?.name)),
    );
    expect(inLoop).toBe(false);
  });

  it('no node list is built for image delivery any more', () => {
    const deploy = fnBody('deployK3s');
    expect(deploy).not.toContain('sshTargets');
    expect(SRC).not.toMatch(/export async function sideloadK3s\(/);
    expect(SRC).not.toMatch(/export async function pushImageToLocalRegistry\(/);
  });
});

describe('deployK3s: the base pull starts at infra-ready and reaches the delivery', () => {
  const deploy = fnBody('deployK3s');

  it('starts after onInfraReady, beside the opportunistic pre-pull, and is not awaited there', () => {
    const infraReady = at(deploy, 'options.onInfraReady({');
    const basePull = at(deploy, 'const basePull =');
    const prePull = at(deploy, '\n  prePullImages({');
    expect(infraReady).toBeLessThan(basePull);
    expect(basePull).toBeLessThan(prePull);
    expect(deploy).not.toMatch(/await basePull\b/);
    expect(deploy).toMatch(/basePull\?\.catch\(\(\) => \{\}\)/);
  });

  it('only an operator-built image pulls a base: a standby pulls none', () => {
    const ref = deploy.slice(deploy.indexOf('const baseRef ='));
    expect(ref.slice(0, ref.indexOf(';'))).toMatch(
      /^const baseRef = planImageDelivery\(\{ role: options\.role \}\)\.deliver\s+\? readRuntimeBaseRef\(projectDir\)\s+: null$/,
    );
    const pull = deploy.slice(deploy.indexOf('const basePull ='));
    expect(pull.slice(0, pull.indexOf(';'))).toMatch(/^const basePull = baseRef\s+\?/);
  });

  it('hands the same promise to applyK3sManifests', () => {
    const apply = deploy.slice(deploy.indexOf('applyK3sManifests({'));
    expect(apply.slice(0, apply.indexOf('}),'))).toMatch(/\n\s+basePull,\n/);
  });
});
