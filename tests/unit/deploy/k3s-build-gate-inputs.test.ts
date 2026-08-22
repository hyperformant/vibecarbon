import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import {
  APP_BUILD_CONTEXT_PATHS,
  buildK3sBuildInputs,
  digestAppSource,
  parseDockerfileContextPaths,
} from '../../../src/lib/deploy/k8s/k3s.js';
// @ts-expect-error — JS module without types
import { StateTracker } from '../../../src/lib/deploy/state.js';

/**
 * Regression coverage for the content-blind `k3s-build` skip gate.
 *
 * The gate's inputs were `{projectName, domain, supabaseUrl, masterPrivateIp}`
 * — no signal at all from the app source tree the build consumes. On a warm
 * redeploy all four are unchanged, so `k3s-build` skipped, `imageTag` was read
 * back from the PRIOR step result, `k3s-sideload` skipped on that same tag, and
 * `k3s-apply` saw an unchanged image: an app-only edit NEVER reached the
 * cluster and push-to-deploy silently kept serving the stale image.
 *
 * Compose never had the hole — its `compose-setup-files` gate folds in
 * `digestDir(bundlePath)` (2026-07-11 prod bug) — and the neighbouring
 * `k3s-apply` gate got the same treatment in #202 (manifest trees) and #234
 * (storage class). This file pins the third member of that family.
 *
 * Found while building PR #243's `warm-redeploy-change` e2e step, whose
 * app-source half mutates `src/server/routes/health.ts`, redeploys against
 * EXISTING state, and asserts the new route serves. That step is the live
 * validation; these are its offline equivalents.
 */

/** The template file PR #243's e2e mutator edits — the exact bug shape. */
const APP_FILE = join('src', 'server', 'routes', 'health.ts');

const REPO_DOCKERFILE = join(process.cwd(), 'carbon', 'Dockerfile');

describe('buildK3sBuildInputs — the app source tree is part of the gate', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-k3s-build-gate-'));
    writeProject(dir);
    // StateTracker keys its state file off process.cwd()/.vibecarbon.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const args = () => ({
    projectName: 'proj',
    domain: 'e3.example.test',
    masterPrivateIp: '10.0.1.1',
    projectDir: dir,
  });

  it('keeps every coarse input the pre-fix gate had', () => {
    const inputs = buildK3sBuildInputs(args());
    expect(inputs.projectName).toBe('proj');
    expect(inputs.domain).toBe('e3.example.test');
    // Baked into the browser bundle (VITE_SUPABASE_URL), so a change to the
    // URL DERIVATION must bust the gate on upgrade, not just a domain change.
    expect(inputs.supabaseUrl).toBe('https://e3.example.test');
    // Baked into the built tag's registry-ref prefix (M3 Task 2).
    expect(inputs.masterPrivateIp).toBe('10.0.1.1');
  });

  it('is stable across calls (content-only digest — no mtimes/absolute paths)', () => {
    expect(buildK3sBuildInputs(args())).toEqual(buildK3sBuildInputs(args()));
    // Same content laid down in a DIFFERENT directory digests identically, so
    // redeploying the same tree from another clone/CI checkout cannot false-bust.
    const twin = mkdtempSync(join(tmpdir(), 'vc-k3s-build-twin-'));
    try {
      writeProject(twin);
      expect(digestAppSource(twin)).toBe(digestAppSource(dir));
    } finally {
      rmSync(twin, { recursive: true, force: true });
    }
  });

  it('re-runs the build when ONLY an app source file changed (the bug)', () => {
    const t1 = new StateTracker('proj', 'e3');
    t1.startStep('k3s-build', buildK3sBuildInputs(args()));
    t1.completeStep('k3s-build', { tag: '10.0.1.1:5000/proj:abc-1', gitSha: 'abc' });

    // Exactly PR #243's mutation: an additive route on the health router.
    // Same project, same domain, same master IP — every pre-fix input identical.
    writeFileSync(
      join(dir, APP_FILE),
      `${readFileSync(join(dir, APP_FILE), 'utf-8')}\napp.get('/e2e-warm-marker', (c) => c.text('marker'));\n`,
    );

    const t2 = new StateTracker('proj', 'e3');
    expect(t2.shouldSkip('k3s-build', buildK3sBuildInputs(args()))).toBe(false);
  });

  it('still skips an unchanged warm redeploy (no needless rebuild + sideload)', () => {
    const t1 = new StateTracker('proj', 'e3');
    t1.startStep('k3s-build', buildK3sBuildInputs(args()));
    t1.completeStep('k3s-build', { tag: '10.0.1.1:5000/proj:abc-1' });

    const t2 = new StateTracker('proj', 'e3');
    expect(t2.shouldSkip('k3s-build', buildK3sBuildInputs(args()))).toBe(true);
  });

  it('re-runs when the Dockerfile itself changed', () => {
    // `.dockerignore` excludes `Dockerfile*` from the build CONTEXT, but the
    // Dockerfile is still what the build executes — a node bump or a new COPY
    // changes the image while leaving every other input identical.
    const before = digestAppSource(dir);
    writeFileSync(
      join(dir, 'Dockerfile'),
      readFileSync(join(dir, 'Dockerfile'), 'utf-8').replace('node:24', 'node:26'),
    );
    expect(digestAppSource(dir)).not.toBe(before);
  });

  it('re-runs when .dockerignore changed (it shapes the context)', () => {
    const before = digestAppSource(dir);
    writeFileSync(join(dir, '.dockerignore'), 'node_modules\ndist\nsrc/**/*.test.ts\n');
    expect(digestAppSource(dir)).not.toBe(before);
  });

  it('re-runs when the lockfile changed (dependency-only edits ship too)', () => {
    const before = digestAppSource(dir);
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
    expect(digestAppSource(dir)).not.toBe(before);
  });

  it('picks up a COPY source the PROJECT added to its own Dockerfile', () => {
    // A customer who adds `COPY public/ ./public/` must get `public/` watched
    // without waiting for the CLI's baseline list to learn about it.
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'public', 'logo.svg'), '<svg/>');
    writeFileSync(
      join(dir, 'Dockerfile'),
      `${readFileSync(join(dir, 'Dockerfile'), 'utf-8')}\nCOPY public/ ./public/\n`,
    );
    const before = digestAppSource(dir);

    writeFileSync(join(dir, 'public', 'logo.svg'), '<svg viewBox="0 0 2 2"/>');
    expect(digestAppSource(dir)).not.toBe(before);
  });

  it('ignores deploy-time ephemera, so a warm redeploy is still a fast path', () => {
    const before = digestAppSource(dir);
    // `.vibecarbon/deploy-state-<env>.json` is rewritten by THIS deploy on
    // every step transition — digesting it would bust the gate on every single
    // run and turn the most expensive step (build + 5-10 min sideload) into an
    // unconditional one.
    mkdirSync(join(dir, '.vibecarbon'), { recursive: true });
    writeFileSync(join(dir, '.vibecarbon', 'deploy-state-e3.json'), '{"version":2,"steps":{}}');
    // Build output + installed deps: `.dockerignore` strips both from the
    // context, and `dist/` changes on every local `npm run build`.
    mkdirSync(join(dir, 'dist', 'client'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'client', 'index.js'), 'console.log(1)');
    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1');
    writeFileSync(join(dir, '.env.local'), 'DB_PASSWORD=hunter2\n');

    expect(digestAppSource(dir)).toBe(before);
  });

  it('does NOT fold in the k8s manifest tree — that is k3s-apply’s gate', () => {
    // Deliberate boundary: a manifest-only edit must re-APPLY (buildK3sApplyInputs
    // digests both trees) without forcing a rebuild + full re-sideload of an
    // image whose bytes are identical.
    const before = digestAppSource(dir);
    writeFileSync(join(dir, 'k8s', 'base', 'kustomization.yaml'), 'resources: [app.yaml]\n');
    expect(digestAppSource(dir)).toBe(before);
  });
});

describe('buildK3sBuildInputs — the docker build args are part of the gate', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-k3s-build-args-'));
    writeProject(dir);
    writeFileSync(join(dir, '.env.local'), 'VITE_SUPABASE_ANON_KEY=key-v1\nDB_PASSWORD=hunter2\n');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const args = () => ({
    projectName: 'proj',
    domain: 'e3.example.test',
    masterPrivateIp: '10.0.1.1',
    projectDir: dir,
  });

  it('busts when a VITE_* value changed (Vite inlines it into the bundle)', () => {
    const t1 = new StateTracker('proj', 'e3');
    t1.startStep('k3s-build', buildK3sBuildInputs(args()));
    t1.completeStep('k3s-build', { tag: '10.0.1.1:5000/proj:abc-1' });

    // `.env.local` is excluded from the build CONTEXT by `.dockerignore`, so
    // the source digest cannot see it — but its VITE_* keys are passed as
    // --build-arg and baked into the browser bundle. Rotating the anon key
    // with no source change must still rebuild.
    writeFileSync(join(dir, '.env.local'), 'VITE_SUPABASE_ANON_KEY=key-v2\nDB_PASSWORD=hunter2\n');
    const t2 = new StateTracker('proj', 'e3');
    expect(t2.shouldSkip('k3s-build', buildK3sBuildInputs(args()))).toBe(false);
  });

  it('does not leak the build-arg VALUES into the gate inputs', () => {
    // Inputs are JSON-stringified by StateTracker; keep secrets to a digest so
    // no future change to the state format can spill an anon key onto disk.
    const serialized = JSON.stringify(buildK3sBuildInputs(args()));
    expect(serialized).not.toContain('key-v1');
    expect(buildK3sBuildInputs(args()).buildArgsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores non-VITE_ keys (a DB password rotation is not a rebuild)', () => {
    const before = buildK3sBuildInputs(args()).buildArgsDigest;
    writeFileSync(join(dir, '.env.local'), 'VITE_SUPABASE_ANON_KEY=key-v1\nDB_PASSWORD=rotated\n');
    expect(buildK3sBuildInputs(args()).buildArgsDigest).toBe(before);
  });
});

describe('a source change cascades build → sideload → apply', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-k3s-cascade-'));
    writeProject(dir);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Mirrors deployK3s's build → sideload → apply gate chain. `nextTag` stands
   * in for buildAppImage's return: a fresh tag every build (the real one
   * carries a UTC timestamp, so a rebuild always yields a new ref).
   */
  function runDeployGates(env: string, nextTag: string) {
    const tracker = new StateTracker('proj', env);
    const buildInputs = buildK3sBuildInputs({
      projectName: 'proj',
      domain: 'e3.example.test',
      masterPrivateIp: '10.0.1.1',
      projectDir: dir,
    });
    let built = false;
    if (!tracker.shouldSkip('k3s-build', buildInputs)) {
      tracker.startStep('k3s-build', buildInputs);
      tracker.completeStep('k3s-build', { tag: nextTag, gitSha: 'abc', isDirty: false });
      built = true;
    }
    const { tag: imageTag } = tracker.getStepResult('k3s-build');

    const sideloadInputs = { imageTag, targets: 'root@1.2.3.4,root@1.2.3.5' };
    let sideloaded = false;
    if (!tracker.shouldSkip('k3s-sideload', sideloadInputs)) {
      tracker.startStep('k3s-sideload', sideloadInputs);
      tracker.completeStep('k3s-sideload');
      sideloaded = true;
    }

    const applyInputs = { imageTag, dbImageTag: 'ghcr.io/o/db:v1', restore: '' };
    let applied = false;
    if (!tracker.shouldSkip('k3s-apply', applyInputs)) {
      tracker.startStep('k3s-apply', applyInputs);
      tracker.completeStep('k3s-apply');
      applied = true;
    }
    return { built, sideloaded, applied, imageTag };
  }

  it('re-runs all three steps, exactly as a cold deploy would', () => {
    const cold = runDeployGates('e3', 'tag-1');
    expect(cold).toMatchObject({ built: true, sideloaded: true, applied: true });

    // Unchanged warm redeploy: nothing re-runs.
    expect(runDeployGates('e3', 'tag-2')).toMatchObject({
      built: false,
      sideloaded: false,
      applied: false,
      imageTag: 'tag-1',
    });

    // One app-source edit → the whole chain moves, because the rebuild mints a
    // new tag and BOTH downstream gates key off it.
    writeFileSync(join(dir, APP_FILE), 'export const health = () => "v2";\n');
    const warm = runDeployGates('e3', 'tag-3');
    expect(warm).toMatchObject({
      built: true,
      sideloaded: true,
      applied: true,
      imageTag: 'tag-3',
    });
  });

  it('cannot skip against a state file written by the pre-fix CLI', () => {
    // The shipped-CLI-upgrade case: every input the old gate had is identical,
    // so without the new keys the fix would never reach a deployed environment.
    const preFix = {
      projectName: 'proj',
      domain: 'e3.example.test',
      supabaseUrl: 'https://e3.example.test',
      masterPrivateIp: '10.0.1.1',
    };
    const t1 = new StateTracker('proj', 'e3');
    t1.startStep('k3s-build', preFix);
    t1.completeStep('k3s-build', { tag: 'stale-tag' });

    const t2 = new StateTracker('proj', 'e3');
    expect(
      t2.shouldSkip(
        'k3s-build',
        buildK3sBuildInputs({
          projectName: 'proj',
          domain: 'e3.example.test',
          masterPrivateIp: '10.0.1.1',
          projectDir: dir,
        }),
      ),
    ).toBe(false);
  });
});

describe('deployK3s wires the content-aware gate end to end', () => {
  const K3S_SRC = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8') as string;
  const deployBody = K3S_SRC.slice(K3S_SRC.indexOf('export async function deployK3s('));

  it('feeds buildK3sBuildInputs into the k3s-build skip-gate', () => {
    expect(deployBody.indexOf('export async function deployK3s(')).toBe(0);
    const gateCall = deployBody.slice(deployBody.indexOf('const buildInputs ='));
    const call = gateCall.slice(0, gateCall.indexOf('});'));
    expect(call).toContain('buildK3sBuildInputs({');
    // The digest is computed FROM the tree the build is handed — the same
    // `projectDir` that reaches buildAppImage two lines later.
    expect(call).toContain('projectDir');
    expect(gateCall).toContain("state.shouldSkip('k3s-build', buildInputs)");
  });

  it('keeps the cascade: the build’s tag is what both downstream gates key on', () => {
    // If any of these three shapes drift, a busted build digest stops
    // propagating and the fix silently reverts to shipping a stale image.
    const chain = deployBody.slice(deployBody.indexOf("state.completeStep('k3s-build'"));
    expect(chain).toContain("const { tag: imageTag } = state.getStepResult('k3s-build')");
    expect(chain.slice(0, chain.indexOf("shouldSkip('k3s-sideload'"))).toContain(
      'const sideloadInputs = { imageTag,',
    );
    const applyCall = chain.slice(chain.indexOf('buildK3sApplyInputs({'));
    expect(applyCall.slice(0, applyCall.indexOf('});'))).toContain('imageTag,');
  });
});

describe('the baseline context list tracks the shipped Dockerfile', () => {
  it('covers every COPY source in carbon/Dockerfile', () => {
    // Structural pin, not recall: if someone adds `COPY public/ ./public/` to
    // the template and forgets the baseline, this fails in the unit tier
    // instead of shipping a gate that is blind to the new directory.
    const sources = parseDockerfileContextPaths(readFileSync(REPO_DOCKERFILE, 'utf-8'));
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      expect(APP_BUILD_CONTEXT_PATHS).toContain(src);
    }
  });

  it('includes the build inputs that are not COPY sources', () => {
    // Consumed by the build without ever appearing in a COPY.
    for (const p of ['Dockerfile', '.dockerignore']) {
      expect(APP_BUILD_CONTEXT_PATHS).toContain(p);
    }
    // …and the app tree PR #243's e2e step mutates.
    expect(APP_BUILD_CONTEXT_PATHS).toContain('src');
  });
});

describe('parseDockerfileContextPaths', () => {
  it('takes COPY/ADD sources and drops the destination', () => {
    expect(parseDockerfileContextPaths('COPY src/ ./src/\nADD scripts ./scripts\n')).toEqual([
      'scripts',
      'src',
    ]);
  });

  it('keeps every source of a multi-source COPY', () => {
    expect(parseDockerfileContextPaths('COPY package.json package-lock.json ./')).toEqual([
      'package-lock.json',
      'package.json',
    ]);
  });

  it('skips build-stage and external-image copies (not project files)', () => {
    expect(
      parseDockerfileContextPaths(
        'COPY --from=builder /app/dist ./dist\nCOPY --from=deps /deps/node_modules ./node_modules\n',
      ),
    ).toEqual([]);
    // A RELATIVE --from source is the case the absolute-path filter does NOT
    // already cover: `dist` here names the BUILDER stage's WORKDIR-relative
    // output, not a `dist/` in the project. Digesting it would watch a path
    // that has nothing to do with the build context.
    expect(parseDockerfileContextPaths('COPY --from=builder dist ./dist')).toEqual([]);
  });

  it('keeps a flagged copy whose source IS a project path', () => {
    expect(parseDockerfileContextPaths('COPY --chown=1001:1001 src/ ./src/')).toEqual(['src']);
  });

  it('follows line continuations', () => {
    expect(parseDockerfileContextPaths('COPY \\\n  content/ \\\n  ./content/\n')).toEqual([
      'content',
    ]);
  });

  it('skips what it cannot resolve to a literal in-context path', () => {
    const text = [
      'COPY *.json ./', // glob — no literal path to digest
      'COPY $BUILD_DIR ./', // build-arg indirection
      'COPY ../outside ./', // outside the context (docker rejects it anyway)
      'ADD https://example.com/x.tgz ./', // remote fetch, not a project file
      'RUN cp src dst', // not a copy instruction
    ].join('\n');
    expect(parseDockerfileContextPaths(text)).toEqual([]);
  });

  it('normalizes ./ prefixes and trailing slashes so paths dedupe', () => {
    expect(parseDockerfileContextPaths('COPY ./src/ ./src/\nCOPY src ./elsewhere/')).toEqual([
      'src',
    ]);
  });
});

/**
 * Lay down the shape of a generated project: the entries the template's
 * Dockerfile consumes, plus the ones a warm redeploy churns.
 */
function writeProject(root: string) {
  const files: Record<string, string> = {
    Dockerfile: [
      'ARG NODE_IMAGE=node:24-alpine3.23',
      // `$NODE_IMAGE`, not the template's `${…}` form: identical Dockerfile
      // semantics, and it keeps biome's noTemplateCurlyInString quiet in a
      // plain JS string. Nothing here parses ARG expansion.
      'FROM $NODE_IMAGE AS builder',
      'WORKDIR /app',
      'COPY package.json package-lock.json ./',
      'RUN npm ci',
      'COPY tsconfig.json tsconfig.server.json biome.json vite.config.ts components.json ./',
      'COPY content/ ./content/',
      'COPY scripts/ ./scripts/',
      'COPY src/ ./src/',
      'RUN npm run build:client',
      'FROM alpine:3.23 AS runner',
      'COPY --from=builder /app/dist ./dist',
      'COPY docker-entrypoint.sh ./',
      '',
    ].join('\n'),
    '.dockerignore': 'node_modules\ndist\n.env.local\n.vibecarbon\n',
    'docker-entrypoint.sh': '#!/bin/sh\nexec "$@"\n',
    'package.json': '{"name":"proj","version":"0.1.0"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'tsconfig.json': '{}',
    'tsconfig.server.json': '{}',
    'biome.json': '{}',
    'vite.config.ts': 'export default {};\n',
    'components.json': '{}',
    'content/docs/index.mdx': '# Docs\n',
    'scripts/build.js': 'process.exit(0);\n',
    [APP_FILE]: "import { Hono } from 'hono';\nconst app = new Hono();\nexport default app;\n",
    'src/client/App.tsx': 'export default function App() { return null; }\n',
    'k8s/base/kustomization.yaml': 'resources: []\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}
